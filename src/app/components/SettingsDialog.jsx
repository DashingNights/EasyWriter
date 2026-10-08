import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Bot, Check, CloudUpload, Globe, RefreshCw, Keyboard, MessageSquare, Mic, Plus, SlidersHorizontal, Tags, Type, X } from 'lucide-react';
import { toast } from 'sonner';
// import { Badge } from '@/components/ui/badge'; // LOCAL LLM (commented out 2026-10-07): the model file row's state
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { FONT_SIZES, TEXT_COLORS, HIGHLIGHTS, FONTS } from '../../extensions.js';
import { withKey } from '../keybinds.js';
import { confirmDialog, DEFAULT_WIDTH } from '../actions.js';
// LOCAL LLM (commented out 2026-10-07): BACKENDS, deleteAssistant, deleteLeftover, openInstall as openAssistantInstall, size, wake.
import { ASSISTANT_DEFAULTS, saveAssistant } from '../assistant/assistant.js';
import QWEN_MODELS from '../../assistant/qwen-models.json';
import { DICTATION_DEFAULTS, LANGUAGES } from '../dictation/core.mjs';
import { mb, ModelFiles } from '../dictation/Dictation.jsx';
import { openInstall } from '../dictation/dictation.js';
import { draftsWithTag, pruneMap, tagList } from '../drafts-meta.js';
import { columnsFollowing } from '../plans.js';
import { getState } from '../store.js';
import { DEFS, effective, overridesOf } from '../keys.mjs';
import { FormDialog } from './FormDialog.jsx';
import { KeybindsSection } from './KeybindsSection.jsx';
import { startTour } from './Onboarding.jsx';

const NONE = '-'; // Radix Select items need a non-empty value: stands for '' (default font, no highlight)
const BLANK = { name: '', fontFamily: '', size: 100, color: 'root', highlight: '', bold: false, italic: false, underline: false };
let rowKey = 0;

// Like the old native selects: a stored value that is not an option falls back to the first option.
const fontValue = (v) => (FONTS.some((f) => f.css === v) ? v : '');
const sizeValue = (v) => String(FONT_SIZES.includes(Number(v)) ? Number(v) : FONT_SIZES[0]);

function Pick({ value, onChange, options, className = 'w-36', label }) {
  return (
    <Select value={value === '' ? NONE : value} onValueChange={(v) => onChange(v === NONE ? '' : v)}>
      <SelectTrigger size="sm" aria-label={label} className={className}><SelectValue /></SelectTrigger>
      <SelectContent>
        {options.map(([v, text]) => <SelectItem key={v} value={v === '' ? NONE : String(v)}>{text}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

const fontOptions = (none) => [['', none], ...FONTS.map((f) => [f.css, f.label])];
const sizeOptions = FONT_SIZES.map((n) => [n, `${n}%`]);
const colorOptions = Object.entries(TEXT_COLORS);
const highlightOptions = [['', 'None'], ...HIGHLIGHTS.map((k) => [k, TEXT_COLORS[k] || k])];

function presetRow(p) {
  return {
    key: ++rowKey,
    id: p.id,
    name: p.name || '',
    fontFamily: fontValue(p.fontFamily),
    size: sizeValue(p.size),
    color: (p.color || 'root') in TEXT_COLORS ? p.color || 'root' : 'root',
    highlight: HIGHLIGHTS.includes(p.highlight) ? p.highlight : '',
    bold: !!p.bold,
    italic: !!p.italic,
    underline: !!p.underline,
  };
}

const readRow = (r, i) => ({
  id: r.id || `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  name: r.name.trim() || `Preset ${i + 1}`,
  fontFamily: r.fontFamily,
  size: Number(r.size),
  color: r.color,
  highlight: r.highlight,
  bold: r.bold,
  italic: r.italic,
  underline: r.underline,
});

const tagRow = (t) => ({ key: ++rowKey, id: t.id, name: t.name, color: t.color });
const readTag = (r, i) => ({ id: r.id, name: r.name.trim() || `Tag ${i + 1}`, color: r.color });
const URL_RE = /^https?:\/\/\S+$/;
const languageOptions = [['auto', 'Automatic'], ...LANGUAGES];
const pathValue = (v) => v.trim().replace(/^"(.*)"$/, '$1'); // "Copy as path" quotes it
const FIELDS = 'grid grid-cols-[8rem_auto] items-center justify-start gap-x-3 gap-y-2'; // label column | control

/** Settings > Dictation (SPEC §7h): status and install, model, the downloaded models, language, microphone; under Advanced,
 * an existing whisper.cpp in place of the downloads. `value` is the dialog's copy of settings.dictation. */
function DictationSection({ value: d, onChange }) {
  const edit = (patch) => onChange((v) => ({ ...v, ...patch }));
  const [status, setStatus] = useState(null);
  const [mics, setMics] = useState([]);
  const [checked, setChecked] = useState(0); // bumped after an install or a deleted model: status and models again
  useEffect(() => {
    let live = true;
    const over = { model: d.model, serverPath: pathValue(d.serverPath), modelPath: pathValue(d.modelPath), serverUrl: d.serverUrl.trim() };
    window.api.dictation.status(over).then((st) => live && setStatus(st), () => live && setStatus(null));
    return () => { live = false; };
  }, [d.model, d.serverPath, d.modelPath, d.serverUrl, checked]);
  useEffect(() => {
    navigator.mediaDevices.enumerateDevices()
      .then((list) => setMics(list.filter((m) => m.kind === 'audioinput' && !['default', 'communications'].includes(m.deviceId))), () => {});
  }, []);
  const install = async () => {
    const done = await openInstall({ model: d.model, language: d.language });
    if (done) edit(done);
    setChecked((n) => n + 1);
  };
  const models = status?.models.map((m) => [m.id, `${m.label} (${mb(m.bytes)})${m.downloaded ? '' : ', not downloaded'}`]) ?? [[d.model, d.model]];
  return (
    <div className={FIELDS}>
      <Label className="text-muted-foreground">Status</Label>
      <div className="flex items-center gap-2" data-dictation-status>
        {!status ? 'Checking...' : status.url ? `Using the server at ${status.url}` : status.ready ? 'Installed' : `Not installed: ${status.missing.map((m) => m.label).join(', ')}`}
        {status && !status.ready && <Button type="button" variant="outline" size="sm" onClick={install}>Install...</Button>}
      </div>
      <Label className="text-muted-foreground">Model</Label>
      <Pick label="Dictation model" value={d.model} onChange={(model) => edit({ model })} options={models} className="w-72" />
      <Label className="self-start pt-0.5 text-muted-foreground">Downloaded</Label>
      <ModelFiles selected={d.model} version={checked} onChange={(patch) => { if (patch) edit(patch); setChecked((n) => n + 1); }} />
      <Label className="text-muted-foreground">Language</Label>
      <Pick label="Dictation language" value={d.language} onChange={(language) => edit({ language })} options={languageOptions} className="w-44" />
      <Label className="text-muted-foreground">Microphone</Label>
      <Pick label="Microphone" value={mics.some((m) => m.deviceId === d.micId) ? d.micId : ''} onChange={(micId) => edit({ micId })} className="w-72"
        options={[['', 'System default'], ...mics.map((m, i) => [m.deviceId, m.label || `Microphone ${i + 1}`])]} />
      <details className="col-span-2" data-agent-deny>
        <summary className="cursor-pointer text-muted-foreground">Advanced: use an existing whisper.cpp</summary>
        <div className={`mt-2 ${FIELDS}`}>
          <Label htmlFor="set-dict-exe" className="text-muted-foreground">Server program</Label>
          <Input id="set-dict-exe" className="h-8 w-96" placeholder="C:\...\whisper-server.exe" value={d.serverPath} onChange={(e) => edit({ serverPath: e.target.value })} />
          <Label htmlFor="set-dict-model" className="text-muted-foreground">Model file</Label>
          <Input id="set-dict-model" className="h-8 w-96" placeholder="C:\...\ggml-....bin" value={d.modelPath} onChange={(e) => edit({ modelPath: e.target.value })} />
          <Label htmlFor="set-dict-url" className="text-muted-foreground">Server URL</Label>
          <Input id="set-dict-url" className="h-8 w-96" placeholder="http://127.0.0.1:8080" value={d.serverUrl} onChange={(e) => edit({ serverUrl: e.target.value })} />
          <span />
          <span className="text-xs text-muted-foreground">The program and model file replace the downloads. A server URL is used as it is: nothing is started.</span>
        </div>
      </details>
    </div>
  );
}

// LOCAL LLM, commented out 2026-10-07 (the user: "i plan to abandon local llm usage, just stick to google api now. comment out all the code for local llm stuff"). Uncomment to restore.
// // What the local server is doing with the model (status().server.state, or 'asleep' after its idle sleep).
// const MODEL_STATE = { ready: 'Loaded', asleep: 'Asleep', starting: 'Loading…', stopped: 'Not loaded', error: 'Failed to load' };
// // settings.assistant.model (main pins each one's files, src/assistant-main.js PINS.models) and its line under the select.
// const MODELS = [['qwen9b', 'Qwen3.5-9B'], ['fable9b', 'Defiant Fable 9B'], ['gemma12b', 'Gemma 4 12B']];
// const PROVIDERS = [['local', 'This computer'], ['google', 'Google AI (Gemini)']];
// const MODEL_HINT = {
//   qwen9b: 'Qwen3.5-9B. Recommended. Works on 8 GB cards.',
//   fable9b: 'Defiant Fable 9B. A community fine-tune of Qwen3.5-9B with fewer refusals. Same tools and image support. Needs about 9 GB of GPU memory, or runs slower on 8 GB cards.',
//   gemma12b: 'Gemma 4 12B. Google\'s model, strong at tool use and pictures. 7.1 GB, needs about 10 GB of GPU memory or runs slower with layers on the CPU.',
// };
// // The models with "Faster replies (MTP)" and its line: what MTP downloads (PINS.models qwen9bMtp, fable9bMtp, gemma12b.draft).
// const MTP_HINT = {
//   qwen9b: 'Predicts two tokens at a time. Uses a 5.9 GB model file in place of the regular one. Turn off if replies get slower.',
//   fable9b: 'Predicts two tokens at a time. Uses a 7.0 GB model file in place of the regular one. Turn off if replies get slower.',
//   gemma12b: 'Predicts two tokens at a time. Adds a 465 MB draft file. Turn off if replies get slower.',
// };

// settings.assistant.permission (the executor's policy for the assistant, SPEC §8 Policy) and its line under the select.
const PERMISSIONS = [['standard', 'Standard'], ['ask', 'Ask first'], ['readonly', 'Read only'], ['all', 'Allow all']];
// settings.assistant.provider (2026-10-08); 'none' turns the assistant off (no chat button, no shortcut).
const PROVIDERS = [['none', 'None'], ['qwen', 'Qwen Cloud'], ['google', 'Google AI (Gemini)'], ['deepseek', 'DeepSeek']];
// Each provider's key and model fields, where its key comes from, its name. Qwen Cloud's model is picked in the chat panel.
const PROVIDER = {
  qwen: { key: 'qwenKey', model: 'qwenModel', from: 'From home.qwencloud.com', label: 'Qwen Cloud' },
  google: { key: 'googleKey', model: 'googleModel', from: 'From aistudio.google.com', model0: 'gemini-3.8-flash', label: 'Google AI' },
  deepseek: { key: 'deepseekKey', model: 'deepseekModel', from: 'From platform.deepseek.com', model0: 'deepseek-flash', label: 'DeepSeek' },
};
const providerOf = (a) => (a.provider === 'none' || Object.hasOwn(PROVIDER, a.provider) ? a.provider : 'qwen');

/** Qwen Cloud's models for the chat panel's model menu (settings.assistant.qwenModels): the known ones, then any added by id. */
function QwenModels({ value: a, edit }) {
  const [id, setId] = useState('');
  const on = a.qwenModels ?? [];
  const all = [...QWEN_MODELS, ...on.filter((m) => !QWEN_MODELS.some((k) => k.id === m)).map((m) => ({ id: m, label: m }))];
  const toggle = (m, v) => edit({ qwenModels: v ? [...on, m] : on.filter((x) => x !== m) });
  const add = () => {
    const m = id.trim();
    if (m && !on.includes(m)) edit({ qwenModels: [...on, m] });
    setId('');
  };
  return (
    <div className="grid gap-1.5" data-qwen-models>
      <span className="text-xs text-muted-foreground">Models to show in the chat panel</span>
      <div className="grid w-[36rem] grid-cols-2 gap-x-4 gap-y-1">
        {all.map((m) => (
          <label key={m.id} className="flex items-center gap-2">
            <Checkbox checked={on.includes(m.id)} onCheckedChange={(v) => toggle(m.id, v === true)} />
            <span>{m.label}</span>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Input aria-label="Model id" className="h-8 w-60" spellCheck={false} placeholder="Another model id" value={id}
          onChange={(e) => setId(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())} />
        <Button type="button" size="sm" variant="outline" disabled={!id.trim()} onClick={add}>Add</Button>
      </div>
    </div>
  );
}
const PERMISSION_HINT = {
  standard: 'Standard. Makes changes you can undo. Asks before deleting, pushing or logging in.',
  ask: 'Ask first. Asks before every change.',
  readonly: 'Read only. Reads and answers. Changes nothing.',
  all: 'Allow all. Does everything without asking, deleting included. You still submit posts on the forum yourself.',
};

/** settings.assistant's Qwen Cloud fields as saved: the key trimmed, the enabled models (at least the default), the chat panel's
 * model one of them. */
function qwenFields(a) {
  const qwenModels = [...new Set((a.qwenModels ?? []).map((m) => m.trim()).filter(Boolean))];
  if (!qwenModels.length) qwenModels.push(ASSISTANT_DEFAULTS.qwenModel);
  return { qwenKey: a.qwenKey.trim(), qwenModels, qwenModel: qwenModels.includes(a.qwenModel) ? a.qwenModel : qwenModels[0] };
}

/** Settings > Assistant (SPEC §7i): Google AI's API key and model with the status, the permission mode and on-screen controls,
 * the picture after each change, resetting the chat panel's place. Local models are off since 2026-10-07: the section's local
 * version (install, the model choice and MTP, model files, backend, idle unload, existing llama.cpp files or a server) is
 * commented out after this one. `value` is the dialog's copy of settings.assistant. */
function AssistantSection({ value: a, onChange }) {
  const edit = (patch) => onChange((v) => ({ ...v, ...patch }));
  const [status, setStatus] = useState(null);
  const provider = providerOf(a);
  const p = PROVIDER[provider] ?? {};
  const [keyField, modelField] = [p.key, p.model];
  useEffect(() => {
    if (!p.key) return undefined; // None: nothing to check
    let live = true;
    window.api.assistant.status({ provider, [keyField]: a[keyField].trim(), [modelField]: a[modelField].trim() })
      .then((st) => live && setStatus(st), () => live && setStatus(null));
    return () => { live = false; };
  }, [a.provider, a[keyField], a[modelField]]);
  const resetPanel = () => {
    edit({ panel: null });
    saveAssistant({ panel: null });
  };
  // Saved at once: the executor reads them at the assistant's next call.
  const savePermission = (patch) => {
    edit(patch);
    saveAssistant(patch);
  };
  // data-agent-deny: the assistant never changes its own settings (assistant-coverage §5).
  if (!p.key) return (
    <div className={FIELDS} data-agent-deny>
      <Label className="self-start pt-2 text-muted-foreground">Provider</Label>
      <div className="grid gap-1.5" data-assistant-provider>
        <Pick label="Assistant provider" value={provider} onChange={(v) => edit({ provider: v })} options={PROVIDERS} className="w-48" />
        <span className="max-w-[36rem] text-xs text-muted-foreground">The assistant is off. The chat button and its key are hidden.</span>
      </div>
    </div>
  );
  return (
    <div className={FIELDS} data-agent-deny>
      <Label className="self-start pt-2 text-muted-foreground">Provider</Label>
      <div className="grid gap-1.5" data-assistant-provider>
        <Pick label="Assistant provider" value={provider} onChange={(v) => edit({ provider: v })} options={PROVIDERS} className="w-48" />
        <div className="flex items-center gap-2">
          <Label htmlFor="set-asst-key" className="w-16 text-muted-foreground">API key</Label>
          <Input id="set-asst-key" type="password" className="h-8 w-80" autoComplete="off" spellCheck={false} placeholder={p.from}
            value={a[keyField]} onChange={(e) => edit({ [keyField]: e.target.value })} />
        </div>
        {provider === 'qwen' ? <QwenModels value={a} edit={edit} /> : (
          <div className="flex items-center gap-2">
            <Label htmlFor="set-asst-model" className="w-16 text-muted-foreground">Model</Label>
            <Input id="set-asst-model" className="h-8 w-80" spellCheck={false} placeholder={p.model0}
              value={a[modelField]} onChange={(e) => edit({ [modelField]: e.target.value })} />
          </div>
        )}
        <span className="max-w-[36rem] text-xs text-muted-foreground">
          Your messages, drafts and board pictures go to {p.label} with this key.
        </span>
        {provider === 'qwen' && (
          <span className="max-w-[36rem] text-xs text-muted-foreground" data-qwen-free>
            To stay on the free tier, turn on Free quota only for each model on
            the <a href="https://home.qwencloud.com/benefits" target="_blank" rel="noreferrer" className="underline">Free Tier page</a>.
            Calls then stop when a model's free quota runs out instead of being billed. Each model has its own quota, valid for 90 days.
          </span>
        )}
      </div>
      <Label className="text-muted-foreground">Status</Label>
      <div className="flex items-center gap-2" data-assistant-status>
        {!status ? 'Checking...' : status.ready ? `Using ${status.providerLabel} (${status.model?.label})` : `Add your ${p.label} API key above`}
      </div>
      <Label className="self-start pt-2 text-muted-foreground">Permissions</Label>
      <div className="grid gap-1.5" data-assistant-permission>
        <Pick label="Assistant permissions" value={a.permission} onChange={(permission) => savePermission({ permission })} options={PERMISSIONS} className="w-48" />
        <span className="max-w-[36rem] text-xs text-muted-foreground" data-permission-hint>{PERMISSION_HINT[a.permission]}</span>
        <div className="flex items-start gap-2">
          <Checkbox id="set-asst-ui" className="mt-0.5" checked={a.uiControl !== false} onCheckedChange={(v) => savePermission({ uiControl: v === true })} />
          <div className="grid gap-0.5">
            <Label htmlFor="set-asst-ui">Let the assistant use on-screen controls</Label>
            <span className="text-xs text-muted-foreground">Lets it click and type in the app when no command fits.</span>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <Checkbox id="set-asst-picture" className="mt-0.5" checked={a.pictureAfterWrite !== false} onCheckedChange={(v) => savePermission({ pictureAfterWrite: v === true })} />
          <div className="grid gap-0.5">
            <Label htmlFor="set-asst-picture">Show the assistant the board after each change</Label>
            <span className="text-xs text-muted-foreground">It checks its work on a picture of the board. Each picture uses about 1,000 tokens.</span>
          </div>
        </div>
      </div>
      <Label className="text-muted-foreground">Chat panel</Label>
      <div><Button type="button" variant="outline" size="sm" disabled={!a.panel} onClick={resetPanel}>Reset chat panel position</Button></div>
    </div>
  );
}

// LOCAL LLM, commented out 2026-10-07 (the user: "i plan to abandon local llm usage, just stick to google api now. comment out all the code for local llm stuff"). Uncomment to restore.
// /** Settings > Assistant (SPEC §7i): status with Install… / Delete…, the permission mode and on-screen controls, the model choice (MTP for each model) and the GPU memory found, unused model files with Delete, the graphics backend, the idle unload, resetting the chat
//  * panel's place; under Advanced, existing llama.cpp files or a server in place of the downloads. `value` is the dialog's copy
//  * of settings.assistant. */
// function AssistantSection({ value: a, onChange }) {
//   const edit = (patch) => onChange((v) => ({ ...v, ...patch }));
//   const [status, setStatus] = useState(null);
//   const [error, setError] = useState('');
//   const [checked, setChecked] = useState(0); // bumped after an install or a delete: status again
//   useEffect(() => {
//     let live = true;
//     const over = { model: a.model, mtp: a.mtp, backend: a.backend, serverPath: pathValue(a.serverPath), modelPath: pathValue(a.modelPath), mmprojPath: pathValue(a.mmprojPath), serverUrl: a.serverUrl.trim(), apiKey: a.apiKey.trim(),
//       provider: a.provider, googleKey: a.googleKey.trim(), googleModel: a.googleModel.trim() };
//     window.api.assistant.status(over).then((st) => live && setStatus(st), () => live && setStatus(null));
//     return () => { live = false; };
//   }, [a.model, a.mtp, a.backend, a.serverPath, a.modelPath, a.mmprojPath, a.serverUrl, a.apiKey, a.provider, a.googleKey, a.googleModel, checked]);
//   const google = a.provider === 'google';
//   // The model choice applies at once (saved, so Install… and the chat use it): a running server stops and, when the new files
//   // are here, starts again on them.
//   const pickModel = async (patch) => {
//     const running = !status?.url && ['ready', 'starting'].includes(status?.server?.state);
//     edit(patch);
//     await saveAssistant(patch);
//     await window.api.assistant.stop();
//     if (running) wake();
//   };
//   const install = async () => {
//     if (await openAssistantInstall()) edit({ installed: true });
//     setChecked((n) => n + 1);
//   };
//   const remove = async () => {
//     if (!(await confirmDialog({
//       title: 'Delete the assistant?',
//       description: 'llama.cpp, the downloaded models and the image projector are removed from this computer (files of your own named under Advanced are kept). They can be downloaded again later.',
//       confirmText: 'Delete',
//       destructive: true,
//     }))) return;
//     setError('');
//     try {
//       await deleteAssistant();
//       edit({ installed: false });
//     } catch (e) {
//       setError(`The assistant was not deleted: ${e.message}`);
//     }
//     setChecked((n) => n + 1);
//   };
//   // An earlier pin's model file (status().leftovers, e.g. the 4B's after the switch to the 9B): never deleted without a click.
//   const removeLeftover = async (f) => {
//     if (!(await confirmDialog({
//       title: `Delete ${f.file} (${size(f.bytes)})?`,
//       description: 'The assistant no longer uses this file. It is removed from this computer.',
//       confirmText: 'Delete',
//       destructive: true,
//     }))) return;
//     setError('');
//     try {
//       await deleteLeftover(f.file);
//     } catch (e) {
//       setError(`${f.file} was not deleted. ${e.message}`);
//     }
//     setChecked((n) => n + 1);
//   };
//   const resetPanel = () => {
//     edit({ panel: null });
//     saveAssistant({ panel: null });
//   };
//   // Saved at once, as the model choice: the executor reads them at the assistant's next call.
//   const savePermission = (patch) => {
//     edit(patch);
//     saveAssistant(patch);
//   };
//   const found = BACKENDS.find(([id]) => id === status?.backend)?.[1];
//   // data-agent-deny: the assistant never changes, installs or deletes its own runtime (assistant-coverage §5).
//   return (
//     <div className={FIELDS} data-agent-deny>
//       <Label className="self-start pt-2 text-muted-foreground">Runs on</Label>
//       <div className="grid gap-1.5" data-assistant-provider>
//         <Pick label="Where the assistant runs" value={a.provider} onChange={(provider) => pickModel({ provider })} options={PROVIDERS} className="w-48" />
//         {google && (
//           <>
//             <div className="flex items-center gap-2">
//               <Label htmlFor="set-asst-gkey" className="w-16 text-muted-foreground">API key</Label>
//               <Input id="set-asst-gkey" type="password" className="h-8 w-80" autoComplete="off" spellCheck={false} placeholder="From aistudio.google.com" value={a.googleKey} onChange={(e) => edit({ googleKey: e.target.value })} />
//             </div>
//             <div className="flex items-center gap-2">
//               <Label htmlFor="set-asst-gmodel" className="w-16 text-muted-foreground">Model</Label>
//               <Input id="set-asst-gmodel" className="h-8 w-80" spellCheck={false} placeholder="gemini-3.8-flash" value={a.googleModel} onChange={(e) => edit({ googleModel: e.target.value })} />
//             </div>
//             <span className="max-w-[36rem] text-xs text-muted-foreground">
//               Your messages, drafts and board pictures go to Google with this key. Nothing runs on this computer.
//             </span>
//           </>
//         )}
//       </div>
//       <Label className="text-muted-foreground">Status</Label>
//       <div className="flex items-center gap-2" data-assistant-status>
//         {!status ? 'Checking…' : status.provider === 'google' ? (status.ready ? `Using Google AI (${status.model?.label})` : 'Add your Google AI API key above')
//           : status.url ? `Using the server at ${status.url}` : status.ready ? (a.installed ? 'Installed' : 'Downloaded, turned off')
//           : `Not installed: ${status.missing.map((m) => m.label).join(', ')}`}
//         {status && !status.url && (!status.ready || !a.installed) && <Button type="button" variant="outline" size="sm" onClick={install}>Install…</Button>}
//       </div>
//       {error && <><span /><p className="text-destructive">{error}</p></>}
//       <Label className="self-start pt-2 text-muted-foreground">Permissions</Label>
//       <div className="grid gap-1.5" data-assistant-permission>
//         <Pick label="Assistant permissions" value={a.permission} onChange={(permission) => savePermission({ permission })} options={PERMISSIONS} className="w-48" />
//         <span className="max-w-[36rem] text-xs text-muted-foreground" data-permission-hint>{PERMISSION_HINT[a.permission]}</span>
//         <div className="flex items-start gap-2">
//           <Checkbox id="set-asst-ui" className="mt-0.5" checked={a.uiControl !== false} onCheckedChange={(v) => savePermission({ uiControl: v === true })} />
//           <div className="grid gap-0.5">
//             <Label htmlFor="set-asst-ui">Let the assistant use on-screen controls</Label>
//             <span className="text-xs text-muted-foreground">Lets it click and type in the app when no command fits.</span>
//           </div>
//         </div>
//         <div className="flex items-start gap-2">
//           <Checkbox id="set-asst-picture" className="mt-0.5" checked={a.pictureAfterWrite !== false} onCheckedChange={(v) => savePermission({ pictureAfterWrite: v === true })} />
//           <div className="grid gap-0.5">
//             <Label htmlFor="set-asst-picture">Show the assistant the board after each change</Label>
//             <span className="text-xs text-muted-foreground">It checks its work on a picture of the board. Each picture uses about 1,000 tokens.</span>
//           </div>
//         </div>
//       </div>
//       {!google && <>
//       <Label className="self-start pt-2 text-muted-foreground">Model</Label>
//       <div className="grid gap-1.5" data-assistant-choice>
//         <div className="flex items-center gap-2">
//           <Pick label="Assistant model" value={a.model} onChange={(model) => pickModel({ model })} options={MODELS} className="w-48" />
//           {status && !status.url && (
//             <span className="text-xs text-muted-foreground" data-gpu-memory>
//               {status.gpuMemory ? `GPU memory ${Math.round(status.gpuMemory.total / 1024)} GB` : 'GPU memory not detected. Assuming 8 GB.'}
//             </span>
//           )}
//         </div>
//         <span className="max-w-[36rem] text-xs text-muted-foreground" data-model-hint>{MODEL_HINT[a.model]}</span>
//         {MTP_HINT[a.model] && (
//           <div className="flex items-start gap-2">
//             <Checkbox id="set-asst-mtp" className="mt-0.5" checked={!!a.mtp} onCheckedChange={(v) => pickModel({ mtp: v === true })} />
//             <div className="grid gap-0.5">
//               <Label htmlFor="set-asst-mtp">Faster replies (MTP)</Label>
//               <span className="text-xs text-muted-foreground" data-mtp-hint>{MTP_HINT[a.model]}</span>
//             </div>
//           </div>
//         )}
//       </div>
//       </>}
//       {!google && status?.ready && status.model && (
//         <>
//           <Label className="text-muted-foreground">Model file</Label>
//           {/* Laid out as Dictation's downloaded models (Dictation.jsx ModelFiles): name, file and size, state, Delete. */}
//           <div className="flex items-center gap-2" data-assistant-model>
//             <span>{status.model.label}</span>
//             <span className="text-muted-foreground">{status.model.file}{status.model.bytes > 0 && `, ${size(status.model.bytes)}`}</span>
//             <Badge variant="secondary">{MODEL_STATE[status.server?.state === 'ready' && status.server.sleeping ? 'asleep' : status.server?.state] ?? 'Not loaded'}</Badge>
//             {!status.url && a.installed && <Button type="button" variant="outline" size="xs" aria-label="Delete the assistant" onClick={remove}>Delete</Button>}
//           </div>
//         </>
//       )}
//       {status?.leftovers?.length > 0 && (
//         <>
//           <Label className="self-start pt-0.5 text-muted-foreground">Unused files</Label>
//           <div className="grid gap-1" data-assistant-leftovers>
//             {status.leftovers.map((f) => (
//               <div key={f.file} className="flex items-center gap-2">
//                 <span>{f.file}</span>
//                 <span className="text-muted-foreground">{size(f.bytes)}</span>
//                 <Button type="button" variant="outline" size="xs" aria-label={`Delete ${f.file}`} onClick={() => removeLeftover(f)}>Delete</Button>
//               </div>
//             ))}
//           </div>
//         </>
//       )}
//       {!google && <>
//       <Label className="text-muted-foreground">Backend</Label>
//       <div className="flex items-center gap-2">
//         <Pick label="Assistant backend" value={a.backend} onChange={(backend) => edit({ backend })} options={BACKENDS} className="w-40" />
//         {a.backend === 'auto' && found && <span className="text-xs text-muted-foreground">Found: {found}</span>}
//       </div>
//       <Label htmlFor="set-asst-idle" className="text-muted-foreground">Idle unload</Label>
//       <div className="flex items-center gap-2">
//         <Input id="set-asst-idle" type="number" min={0} max={1440} step={1} className="h-8 w-28" value={a.idleUnloadMinutes}
//           onChange={(e) => edit({ idleUnloadMinutes: e.target.value })} />
//         <span className="text-xs text-muted-foreground">Minutes without a request before the model is unloaded (0 = keep loaded)</span>
//       </div>
//       </>}
//       <Label className="text-muted-foreground">Chat panel</Label>
//       <div><Button type="button" variant="outline" size="sm" disabled={!a.panel} onClick={resetPanel}>Reset chat panel position</Button></div>
//       <details className="col-span-2" hidden={google}>
//         <summary className="cursor-pointer text-muted-foreground">Advanced: use an existing llama.cpp or server</summary>
//         <div className={`mt-2 ${FIELDS}`}>
//           <Label htmlFor="set-asst-exe" className="text-muted-foreground">Server program</Label>
//           <Input id="set-asst-exe" className="h-8 w-96" placeholder="C:\…\llama-server.exe" value={a.serverPath} onChange={(e) => edit({ serverPath: e.target.value })} />
//           <Label htmlFor="set-asst-model" className="text-muted-foreground">Model file</Label>
//           <Input id="set-asst-model" className="h-8 w-96" placeholder="C:\…\Qwen3.5-9B-Q4_K_M.gguf" value={a.modelPath} onChange={(e) => edit({ modelPath: e.target.value })} />
//           <Label htmlFor="set-asst-mmproj" className="text-muted-foreground">Projector file</Label>
//           <Input id="set-asst-mmproj" className="h-8 w-96" placeholder="C:\…\mmproj-BF16.gguf" value={a.mmprojPath} onChange={(e) => edit({ mmprojPath: e.target.value })} />
//           <Label htmlFor="set-asst-url" className="text-muted-foreground">Server URL</Label>
//           <Input id="set-asst-url" className="h-8 w-96" placeholder="http://127.0.0.1:8080" value={a.serverUrl} onChange={(e) => edit({ serverUrl: e.target.value })} />
//           <Label htmlFor="set-asst-key" className="text-muted-foreground">API key</Label>
//           <Input id="set-asst-key" className="h-8 w-96" autoComplete="off" spellCheck={false} placeholder="The server's --api-key, if it has one" value={a.apiKey} onChange={(e) => edit({ apiKey: e.target.value })} />
//           <span />
//           <span className="text-xs text-muted-foreground">
//             The files replace the downloads. A server URL is used as it is. Nothing is started, and your messages and drafts go to that
//             server with the API key, so leave it empty unless you run it yourself.
//           </span>
//         </div>
//       </details>
//     </div>
//   );
// }

const SWATCH = 'size-8 shrink-0 cursor-pointer rounded-md border border-input bg-input/30 p-1 [&::-webkit-color-swatch]:rounded-sm [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0';

// The section nav: one entry per <Section> in the dialog, in the same order ([id, nav label, icon]).
const AGENT_PORT = 47823; // settings.agent.port when unset (main's src/agent-server.js PORT)
const copy = (text) => navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast.error('Could not copy'));

/** Settings > Local AI agents (SPEC §8 Agents): the switch, the port, and how to connect an MCP client, by URL or by the stdio
 * config main reports (agent.status: the app's own executable runs bin/daf-agent.js as Node), shown while the switch is on. The
 * URL follows the port field; the status is the saved settings' own. */
function AgentsSection({ enabled, setEnabled, port, setPort }) {
  const [st, setSt] = useState(null);
  useEffect(() => { window.api.agent.status().then(setSt, () => {}); }, []);
  const url = `http://127.0.0.1:${port}/mcp`;
  const stdio = st && JSON.stringify({ mcpServers: { easywriter: st.stdio } }, null, 2);
  const unsaved = st && (enabled !== st.on || (enabled && Number(port) !== st.port));
  const state = !st ? 'Checking...' : !st.on ? 'Off' : st.url ? `Listening on port ${st.port}` : st.error ?? 'Starting...';
  return (
    <div className="grid gap-4" data-agent-deny>
      <div className="flex items-start gap-2">
        <Switch id="set-agents" className="mt-0.5" checked={enabled} onCheckedChange={setEnabled} />
        <div className="grid gap-0.5">
          <Label htmlFor="set-agents">Allow local AI agents (MCP)</Label>
          <span className="max-w-[36rem] text-xs text-muted-foreground">
            Lets MCP clients work in this app. Any program on this computer can connect while this is on. Deleting and pushing
            ask you every time, and the forum is never submitted.
          </span>
        </div>
      </div>
      {enabled && <div className={FIELDS}>
        <Label htmlFor="set-agents-port" className="text-muted-foreground">Port</Label>
        <Input id="set-agents-port" type="number" min={1024} max={65535} step={1} className="h-8 w-28" value={port}
          onChange={(e) => setPort(e.target.value)} />
        <Label className="text-muted-foreground">Status</Label>
        <span data-agent-status>{state}{unsaved && <span className="text-muted-foreground">. Save to apply your changes.</span>}</span>
        <Label htmlFor="set-agents-url" className="self-start pt-2 text-muted-foreground">Server URL</Label>
        <div className="grid gap-1.5">
          <div className="flex items-center gap-2">
            <Input id="set-agents-url" readOnly className="h-8 w-80 font-mono text-xs" value={url} onFocus={(e) => e.target.select()} />
            <Button type="button" variant="outline" size="sm" onClick={() => copy(url)}>Copy</Button>
          </div>
          <span className="text-xs text-muted-foreground">For clients that connect to a URL (Streamable HTTP).</span>
        </div>
        <Label className="self-start pt-2 text-muted-foreground">Stdio config</Label>
        <div className="grid gap-1.5">
          <pre className="max-h-48 max-w-[36rem] overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs select-text" data-agent-stdio>
            {stdio ?? 'Checking...'}
          </pre>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={!stdio} onClick={() => copy(stdio)}>Copy</Button>
            <span className="text-xs text-muted-foreground">For clients that start the server themselves. Paste it into their MCP config.</span>
          </div>
        </div>
      </div>}
    </div>
  );
}

const SECTIONS = [['general', 'General', SlidersHorizontal], ['presets', 'Presets', Type], ['tags', 'Tags', Tags], ['dictation', 'Dictation', Mic],
  ['assistant', 'Assistant', MessageSquare], ['browser', 'Browser', Globe], ['keybinds', 'Keybinds', Keyboard], ['agents', 'AI agents', Bot],
  ['github', 'GitHub backup', CloudUpload]];

// An IPC rejection's own message, without Electron's "Error invoking remote method ..." prefix.
const ipcMessage = (e) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

/** Settings > GitHub backup (SPEC §4b). Logging in and out happens at once (GitHub's device flow: main opens GitHub's page and
 * the user enters the code shown here); the rest is saved with Save. The picked repository is checked at once, and
 * `setProblem` gets why it cannot be used ('' when it can). Push now syncs with the saved settings. */
function GitHubSection({ value: g, onChange, setProblem }) {
  const edit = (patch) => onChange({ ...g, ...patch });
  const [st, setSt] = useState(null);
  const [code, setCode] = useState(null);
  const [repos, setRepos] = useState(null);
  const [check, setCheck] = useState(null);
  const [starting, setStarting] = useState(false);
  const login = st?.login;
  useEffect(() => {
    window.api.github.status().then(setSt, () => {});
    return window.api.github.onEvent(setSt);
  }, []);
  const loadRepos = () => {
    setRepos(null); // the list shows Loading... until GitHub answers
    window.api.github.repos().then(setRepos, (e) => { setRepos([]); toast.error(ipcMessage(e)); });
  };
  useEffect(() => { if (login) loadRepos(); }, [login]);
  useEffect(() => {
    setCheck(null);
    if (!login || !g.repo) return;
    let live = true;
    window.api.github.checkRepo(g.repo).then((c) => live && setCheck(c), () => {});
    return () => { live = false; };
  }, [login, g.repo]);
  // Only a repository that can never work stops Save; one GitHub cannot be reached for now is checked again by each sync.
  useEffect(() => {
    setProblem(!g.enabled || !login ? '' : !g.repo ? 'Choose a repository for the GitHub backup.' : check?.refused ? check.error : '');
  }, [g.enabled, g.repo, login, check]);

  const startLogin = async () => {
    setStarting(true);
    try {
      setCode(await window.api.github.login());
      setSt(await window.api.github.loginWait());
    } catch (e) {
      if (!/cancelled/.test(ipcMessage(e))) toast.error(ipcMessage(e));
    }
    setCode(null);
    setStarting(false);
  };
  const logout = () => window.api.github.logout().then(() => { setRepos(null); return window.api.github.status().then(setSt); });
  const pushNow = () => window.api.github.syncNow().then(() => toast('Pushed to GitHub'), (e) => toast.error(ipcMessage(e)));
  const saved = st?.enabled && st.repo === g.repo && g.enabled;
  const repoNote = !g.repo ? '' : !check ? 'Checking...' : !check.ok ? check.error
    : check.empty ? 'Empty. The first push starts the backup.' : 'Holds an EasyWriter backup. Saving merges it with this computer.';
  const state = st?.busy ? 'Syncing...' : st?.error ? st.error : st?.lastSync
    ? `Last synced ${new Date(st.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Not synced yet';

  if (!st) return <span className="text-sm text-muted-foreground">Checking...</span>;
  return (
    <div className="grid gap-4" data-agent-deny>
      <div className={FIELDS}>
        <Label className="text-muted-foreground">Account</Label>
        {login ? (
          <div className="flex items-center gap-2">
            <span className="text-sm">{login}</span>
            <Button type="button" variant="outline" size="sm" onClick={logout}>Log out</Button>
          </div>
        ) : code ? (
          <div className="flex items-center gap-2 text-sm">
            Enter <code className="rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-base select-text">{code.userCode}</code> on GitHub
            <Button type="button" variant="outline" size="sm" onClick={() => copy(code.userCode)}>Copy</Button>
            <Button type="button" variant="ghost" size="sm" onClick={logout}>Cancel</Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={!st.configured || starting} onClick={startLogin}>Log in with GitHub...</Button>
            {!st.configured && <span className="text-xs text-muted-foreground">This build has no GitHub app ID.</span>}
          </div>
        )}
      </div>
      {login && <>
        <div className="flex items-start gap-2">
          <Switch id="set-github" className="mt-0.5" checked={g.enabled} onCheckedChange={(v) => edit({ enabled: v })} />
          <div className="grid gap-0.5">
            <Label htmlFor="set-github">Back up to GitHub</Label>
            <span className="max-w-[36rem] text-xs text-muted-foreground">
              Drafts with their undo history, plans, flowcharts, prefabs, threads and tags go to a private repository of yours.
            </span>
          </div>
        </div>
        {g.enabled && <div className={FIELDS}>
          <Label className="self-start pt-2 text-muted-foreground">Repository</Label>
          <div className="grid gap-1.5">
            <div className="flex items-start gap-2">
              {/* Search by typing; a click or Enter picks a repository */}
              <Command className="h-auto w-96 rounded-md border bg-transparent" aria-label="Repository">
                <CommandInput placeholder="Search your private repositories..." />
                <CommandList className="max-h-48">
                  <CommandEmpty>{repos ? 'No private repository found.' : 'Loading...'}</CommandEmpty>
                  {repos && [...new Set([g.repo, ...repos])].filter(Boolean).map((r) => (
                    <CommandItem key={r} value={r} onSelect={() => edit({ repo: r })}>
                      <Check className={r === g.repo ? '' : 'invisible'} />
                      <span className="truncate">{r}</span>
                    </CommandItem>
                  ))}
                </CommandList>
              </Command>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Reload the list" title="Reload the list" disabled={!repos}
                onClick={loadRepos}><RefreshCw /></Button>
            </div>
            <span className="text-sm">{g.repo || 'No repository chosen'}</span>
            {repoNote && <span className={`text-xs ${check && !check.ok ? 'text-destructive' : 'text-muted-foreground'}`}>{repoNote}</span>}
          </div>
          <Label htmlFor="set-github-every" className="text-muted-foreground">Push every</Label>
          <div className="flex items-center gap-2">
            <Input id="set-github-every" type="number" min={0.5} max={1440} step={0.5} className="h-8 w-28" value={g.minutes}
              onChange={(e) => edit({ minutes: e.target.value })} />
            <span className="text-xs text-muted-foreground">minutes, when something changed (0.5 is 30 seconds)</span>
          </div>
          <Label className="text-muted-foreground">On close</Label>
          <Pick label="On close" value={g.onClose} onChange={(onClose) => edit({ onClose })} className="w-44"
            options={[['ask', 'Ask to push'], ['push', 'Push'], ['skip', "Don't push"]]} />
          <Label className="text-muted-foreground">Status</Label>
          <div className="flex items-center gap-2">
            <span className={`text-sm ${st.error && !st.busy ? 'text-destructive' : ''}`}>{saved ? state : 'Save to start the backup.'}</span>
            {saved && <Button type="button" variant="outline" size="sm" disabled={st.busy} onClick={pushNow}>Push now</Button>}
          </div>
        </div>}
      </>}
    </div>
  );
}

/** A titled section of the dialog's scrolling column. The last one is at least the column's height past its
 * top border, so every section can be scrolled to just below its border (jump in SettingsDialog). */
function Section({ id, title, hint, children }) {
  return (
    <section data-section={id} aria-labelledby={`set-sec-${id}`} className="flex flex-col gap-3 border-t py-6 first:border-t-0 first:pt-0 last:min-h-[calc(100%_+_1px)]">
      <div className="grid gap-1.5">
        <h3 id={`set-sec-${id}`} className="text-sm leading-none font-semibold">{title}</h3>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

const selectText = (el) => el?.select(); // stable ref callback: the first field opens selected, as the dialog's autofocus did

/** Settings + presets manager, scrolled to `section` (a SECTIONS id) when given. Closes with the settings patch, or null. */
export function SettingsDialog({ settings: s, section, onClose }) {
  const [width, setWidth] = useState(String(s.forumWidth));
  const [theme, setTheme] = useState(s.theme !== 'light' ? 'dark' : 'light');
  const [baseFont, setBaseFont] = useState(fontValue(s.baseFont));
  const [baseSize, setBaseSize] = useState(sizeValue(s.baseSize));
  const [historyLimit, setHistoryLimit] = useState(String(s.historyLimit));
  const [dictation, setDictation] = useState(() => ({ ...DICTATION_DEFAULTS, ...s.dictation }));
  const [assistant, setAssistant] = useState(() => ({ ...ASSISTANT_DEFAULTS, ...s.assistant }));
  const [agents, setAgents] = useState(!!s.agent?.enabled);
  const [agentPort, setAgentPort] = useState(String(s.agent?.port ?? AGENT_PORT));
  const [idleOpacity, setIdleOpacity] = useState(s.browserIdleOpacity ?? 70);
  const [autoTab, setAutoTab] = useState(!!s.browserAutoTab);
  const [notchFloor, setNotchFloor] = useState(s.browserNotchFloor !== false);
  const [keybinds, setKeybinds] = useState(() => effective(DEFS, s.keybinds));
  const [github, setGithub] = useState(() => {
    const g = { enabled: false, repo: '', intervalSec: 300, onClose: 'ask', ...s.github };
    return { enabled: g.enabled, repo: g.repo, onClose: g.onClose, minutes: String(g.intervalSec / 60) };
  });
  const [githubProblem, setGithubProblem] = useState('');
  const [rows, setRows] = useState(() => s.presets.map(presetRow));
  const edit = (key, patch) => setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const [tagRows, setTagRows] = useState(() => tagList(s).map(tagRow));
  const editTag = (key, patch) => setTagRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const moveTag = (i, by) => setTagRows((list) => {
    const out = [...list];
    [out[i], out[i + by]] = [out[i + by], out[i]];
    return out;
  });
  // A tag that drafts carry or plan columns follow is deleted only after a confirmation; those drafts are untagged on Save
  // (draftTags below) and the plan store unmaps those columns (plans.js).
  const deleteTag = async (r, i) => {
    const used = draftsWithTag(s, getState().drafts, r.id).length;
    const cols = columnsFollowing(r.id);
    if ((used || cols) && !(await confirmDialog({
      title: `Delete the tag "${r.name.trim() || `Tag ${i + 1}`}"?`,
      description: [used && 'The drafts that carry it become untagged; no draft is deleted.',
        cols && `${cols === 1 ? '1 plan column stops' : `${cols} plan columns stop`} following it (their tickets stay; linked drafts move to No status).`].filter(Boolean).join(' '),
      confirmText: 'Delete tag',
      destructive: true,
    }))) return;
    setTagRows((list) => list.filter((x) => x.key !== r.key));
  };

  // Section nav: a click scrolls the column to the section; scrolling highlights the section at the column's top (the last
  // one once the end is reached).
  const pane = useRef(null);
  const [active, setActive] = useState(section ?? SECTIONS[0][0]);
  const spy = () => {
    const el = pane.current;
    const secs = [...el.children];
    const end = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    setActive((end ? secs.at(-1) : secs.findLast((x) => x.offsetTop <= el.scrollTop + 4)).dataset.section);
  };
  const jump = (id, instant = false) => {
    const sec = pane.current.querySelector(`:scope > [data-section="${id}"]`);
    // Just below the section's top border: its heading lands 1.5rem (its padding) below the column's top.
    pane.current.scrollTo({ top: sec.offsetTop + sec.clientTop, behavior: instant || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  // Opened at a section: the column scrolls there as it mounts (the dialog's portal mounts after this component's first commit).
  const paneRef = useCallback((el) => {
    pane.current = el;
    if (el && section) jump(section, true);
  }, []);

  // "Show the tour" saves like Save (its error shown and the tour not started when a field is invalid), then Settings closes
  // and the tour starts. A plain button, not a submit button: Enter in a field must not start the tour. The flag is set only for
  // the click's own submit (dispatched synchronously); one the browser blocks (a number field out of range) must not leave it set.
  const tour = useRef(false);
  const validate = () => {
    const w = Number(width);
    if (!(Number.isInteger(w) && w >= 320 && w <= 4000)) return 'Forum width must be a whole number between 320 and 4000.';
    if (dictation.serverUrl.trim() && !URL_RE.test(dictation.serverUrl.trim())) return 'The dictation server URL must start with http:// or https://.';
    // LOCAL LLM (commented out 2026-10-07): the server URL and idle unload checks.
    // if (assistant.serverUrl.trim() && !URL_RE.test(assistant.serverUrl.trim())) return 'The assistant server URL must start with http:// or https://.';
    // if (!/^\d+$/.test(String(assistant.idleUnloadMinutes)) || Number(assistant.idleUnloadMinutes) > 1440) return 'Idle unload must be a whole number of minutes between 0 and 1440.';
    if (!/^\d+$/.test(agentPort) || Number(agentPort) < 1024 || Number(agentPort) > 65535) return 'The agents port must be a whole number between 1024 and 65535.';
    if (!(Number(github.minutes) >= 0.5 && Number(github.minutes) <= 1440)) return 'Push every must be between 0.5 and 1440 minutes.';
    if (githubProblem) return githubProblem;
    return /^\d+$/.test(historyLimit) && Number(historyLimit) <= 500 ? '' : 'Undo history must be a whole number between 0 and 500.';
  };
  const result = () => ({
    forumWidth: Number(width),
    theme,
    baseFont,
    baseSize: Number(baseSize),
    historyLimit: Number(historyLimit),
    presets: rows.map(readRow),
    tags: tagRows.map(readTag),
    draftTags: pruneMap(s.draftTags, getState().drafts, tagRows),
    dictation: { ...dictation, serverPath: pathValue(dictation.serverPath), modelPath: pathValue(dictation.modelPath), serverUrl: dictation.serverUrl.trim() },
    assistant: {
      ...assistant, provider: providerOf(assistant), ...qwenFields(assistant),
      googleKey: assistant.googleKey.trim(), googleModel: assistant.googleModel.trim() || 'gemini-3.8-flash',
      deepseekKey: assistant.deepseekKey.trim(), deepseekModel: assistant.deepseekModel.trim() || 'deepseek-flash',
      // LOCAL LLM (commented out 2026-10-07): serverPath: pathValue(assistant.serverPath), modelPath: pathValue(assistant.modelPath),
      // mmprojPath: pathValue(assistant.mmprojPath), serverUrl: assistant.serverUrl.trim(), apiKey: assistant.apiKey.trim(),
      // idleUnloadMinutes: Number(assistant.idleUnloadMinutes),
    },
    agent: { ...s.agent, enabled: agents, port: Number(agentPort) },
    browserIdleOpacity: idleOpacity,
    browserAutoTab: autoTab,
    browserNotchFloor: notchFloor,
    keybinds: overridesOf(DEFS, keybinds), // §7k: only the changed bindings
    github: { enabled: github.enabled, repo: github.repo, onClose: github.onClose, intervalSec: Math.round(Number(github.minutes) * 60) },
  });

  return (
    // Fixed height, centred in the room below the 34 px title strip (+17 px) with a 1rem margin; only the right column scrolls.
    <FormDialog title="Settings" okText="Save" validate={validate} onClose={onClose}
      result={() => { if (tour.current) startTour(); return result(); }}
      className="top-[calc(50%_+_17px)] h-[min(60rem,calc(100vh_-_34px_-_2rem))] p-6 sm:max-w-[min(68rem,calc(100vw_-_2rem))] *:data-[slot=dialog-close]:top-6 *:data-[slot=dialog-close]:right-6 [&>form]:gap-4">
      <div className="grid min-h-0 grid-cols-[11rem_minmax(0,1fr)] gap-6">
        <nav aria-label="Settings sections" className="flex flex-col gap-1">
          {SECTIONS.map(([id, label, Icon]) => (
            <Button key={id} type="button" variant="ghost" size="sm" aria-current={active === id || undefined} onClick={() => jump(id)}
              className="justify-start text-muted-foreground aria-[current=true]:bg-accent aria-[current=true]:text-accent-foreground">
              <Icon />{label}
            </Button>
          ))}
        </nav>
        {/* -ml-1 pl-1: room for the 3 px focus ring of controls at the left edge, which the scroll box would clip */}
        <div ref={paneRef} onScroll={spy} className="relative -ml-1 min-h-0 overflow-y-auto pr-3 pl-1" data-settings-pane>
          <Section id="general" title="General">
            <div className={FIELDS}>
              <Label htmlFor="set-width" className="text-muted-foreground">Forum width</Label>
              <div className="flex items-center gap-2">
                <Input id="set-width" type="number" min={320} max={4000} step={1} className="h-8 w-28" value={width} autoFocus ref={selectText}
                  onChange={(e) => setWidth(e.target.value)} />
                px
                <Button type="button" variant="outline" size="sm" onClick={() => setWidth(String(DEFAULT_WIDTH))}>Reset</Button>
              </div>
              <Label className="text-muted-foreground">Page theme</Label>
              <Pick label="Page theme" value={theme} onChange={setTheme} options={[['dark', 'Dark'], ['light', 'Light']]} />
              <Label className="text-muted-foreground">Base font</Label>
              <Pick label="Base font" value={baseFont} onChange={setBaseFont} options={fontOptions('Default')} className="w-44" />
              <Label className="text-muted-foreground">Base size</Label>
              <Pick label="Base size" value={baseSize} onChange={setBaseSize} options={sizeOptions} className="w-24" />
              <Label htmlFor="set-history" className="text-muted-foreground">Undo history</Label>
              <div className="flex items-center gap-2">
                <Input id="set-history" type="number" min={0} max={500} step={1} className="h-8 w-28" value={historyLimit}
                  onChange={(e) => setHistoryLimit(e.target.value)} />
                <span className="text-xs text-muted-foreground">Steps kept per draft, also after closing the app (0 = none after closing)</span>
              </div>
              <Label className="text-muted-foreground">Tour</Label>
              <div>
                <Button type="button" variant="outline" size="sm" onClick={(e) => { tour.current = true; e.currentTarget.form.requestSubmit(); tour.current = false; }}>Show the tour</Button>
              </div>
            </div>
          </Section>

          <Section id="presets" title="Presets" hint="Their keys apply them in order (Keybinds, Font preset 1 to 9)">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  {['Name', 'Font', 'Size', 'Colour', 'Highlight', 'B', 'I', 'U', ''].map((h, i) => <th key={i} className="p-1 font-medium">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td className="p-1"><Input aria-label="Preset name" className="h-8 w-36" value={r.name} onChange={(e) => edit(r.key, { name: e.target.value })} /></td>
                    <td className="p-1"><Pick label="Font" value={r.fontFamily} onChange={(v) => edit(r.key, { fontFamily: v })} options={fontOptions('Default')} /></td>
                    <td className="p-1"><Pick label="Size" value={r.size} onChange={(v) => edit(r.key, { size: v })} options={sizeOptions} className="w-22" /></td>
                    <td className="p-1"><Pick label="Colour" value={r.color} onChange={(v) => edit(r.key, { color: v })} options={colorOptions} className="w-32" /></td>
                    <td className="p-1"><Pick label="Highlight" value={r.highlight} onChange={(v) => edit(r.key, { highlight: v })} options={highlightOptions} className="w-32" /></td>
                    {['bold', 'italic', 'underline'].map((k) => (
                      <td key={k} className="p-1">
                        <Checkbox aria-label={k[0].toUpperCase() + k.slice(1)} checked={r[k]} onCheckedChange={(v) => edit(r.key, { [k]: v === true })} />
                      </td>
                    ))}
                    <td className="p-1">
                      <Button type="button" variant="ghost" size="icon-sm" aria-label="Delete preset" title="Delete preset"
                        onClick={() => setRows((list) => list.filter((x) => x.key !== r.key))}><X /></Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => setRows((list) => [...list, presetRow(BLANK)])}><Plus />Add preset</Button>
            </div>
          </Section>

          <Section id="tags" title="Tags" hint="Draft status, in workflow order">
            <div className="grid gap-1">
              {tagRows.map((r, i) => (
                <div key={r.key} className="flex items-center gap-1">
                  <input type="color" aria-label="Tag colour" title="Tag colour" className={SWATCH} value={r.color} onChange={(e) => editTag(r.key, { color: e.target.value })} />
                  <Input aria-label="Tag name" className="h-8 w-44" placeholder={`Tag ${i + 1}`} value={r.name} onChange={(e) => editTag(r.key, { name: e.target.value })} />
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Move up" title="Move up" disabled={!i} onClick={() => moveTag(i, -1)}><ArrowUp /></Button>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Move down" title="Move down" disabled={i === tagRows.length - 1}
                    onClick={() => moveTag(i, 1)}><ArrowDown /></Button>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Delete tag" title="Delete tag" onClick={() => deleteTag(r, i)}><X /></Button>
                </div>
              ))}
            </div>
            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => setTagRows((list) => [...list, tagRow({ id: crypto.randomUUID(), name: '', color: '#a3a3a3' })])}>
                <Plus />Add tag
              </Button>
            </div>
          </Section>

          <Section id="dictation" title="Dictation" hint="Hold the mic button">
            <DictationSection value={dictation} onChange={setDictation} />
          </Section>

          <Section id="assistant" title="Assistant" hint={withKey('The chat button', 'app.assistant')}>
            <AssistantSection value={assistant} onChange={setAssistant} />
          </Section>

          <Section id="browser" title="Browser" hint="The Browser page, and the pane a tab opens in over the editor, plans and flowcharts">
            <div className={FIELDS}>
              <Label className="text-muted-foreground">Unfocused opacity</Label>
              <div className="flex items-center gap-3">
                <Slider aria-label="Unfocused opacity" min={10} max={100} step={5} value={[idleOpacity]} onValueChange={([v]) => setIdleOpacity(v)} className="w-56" />
                <span className="w-10 text-sm tabular-nums">{idleOpacity}%</span>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Switch id="set-browser-notchfloor" className="mt-0.5" checked={notchFloor} onCheckedChange={setNotchFloor} />
              <div className="grid gap-0.5">
                <Label htmlFor="set-browser-notchfloor">Keep the pane's controls visible</Label>
                <span className="text-xs text-muted-foreground">An unfocused pane's top bar stays at 40% opacity or more.</span>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Switch id="set-browser-autotab" className="mt-0.5" checked={autoTab} onCheckedChange={setAutoTab} />
              <div className="grid gap-0.5">
                <Label htmlFor="set-browser-autotab">Open a tab on an empty Browser page</Label>
                <span className="text-xs text-muted-foreground">Going to the Browser page with no tabs open starts one on Google.</span>
              </div>
            </div>
          </Section>

          <Section id="keybinds" title="Keybinds" hint="Click a key to change it, + to add one. Warnings never stop a keybind from saving.">
            <KeybindsSection value={keybinds} onChange={setKeybinds} />
          </Section>

          <Section id="agents" title="Local AI agents">
            <AgentsSection enabled={agents} setEnabled={setAgents} port={agentPort} setPort={setAgentPort} />
          </Section>

          <Section id="github" title="GitHub backup">
            <GitHubSection value={github} onChange={setGithub} setProblem={setGithubProblem} />
          </Section>
        </div>
      </div>
    </FormDialog>
  );
}
