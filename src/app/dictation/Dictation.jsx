import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { MessageSquareText, Mic, MicOff, Minimize2 } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { refocusEditor } from '../actions.js';
import { Tip } from '../components/Tip.jsx';
import { can } from '../gates.mjs';
import { keyIs, withKey } from '../keybinds.js';
import { getState, useStore } from '../store.js';
import { viewportRect } from '../viewport.js';
import { LANGUAGES } from './core.mjs';
import {
  cancelInstall, CLOSE_STEPS, closeInstall, deleteModel, dismiss, DISMISS_MS, install, level, minimize, modelInUse, pttDown, pttUp,
  useDictation, warm,
} from './dictation.js';

// Push-to-talk dictation chrome (SPEC §7h), mounted in the main column's area (App.jsx): the PTT island above the sidebar
// button (in a workspace at the bottom-right), the bottom column over the toolbar island (the transcript pane, a pod on top of
// a card that grows upward, with the §7c notice stack resting on it) and the install dialog; Settings > Dictation shows ModelFiles.

const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 13;
const keep = (e) => e.preventDefault(); // buttons that never take the focus from the editor
export const mb = (bytes) => `${Math.max(1, Math.round(bytes / 1048576))} MB`;
const isHoldKey = (e) => (e.key === ' ' || e.key === 'Enter') && !e.repeat;

/** Hold handlers for a button: pointer (captured, so a release anywhere ends it) and Space / Enter. */
export function hold(down, up) {
  return {
    onMouseDown: keep,
    onPointerDown: (e) => {
      if (e.button) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      down();
    },
    onPointerUp: up,
    onPointerCancel: up,
    onLostPointerCapture: up,
    onKeyDown: (e) => isHoldKey(e) && (e.preventDefault(), down()),
    onKeyUp: (e) => (e.key === ' ' || e.key === 'Enter') && up(),
  };
}

let lastBottom = null; // the column's bottom offset over the toolbar island, kept for the views without one
const GAP = 8; // between the toolbar island, the pane and the notice stack

/** The bottom column's placement (in the main column's area `box`) in the page's viewport (viewport.js): centred, its bottom
 * 8 px over the toolbar island; the pane's width (at most 85 % of the island's width, 74 % of the viewport without it) and
 * greatest height (25 % of the viewport's). Measured again when the view, the viewport (e.g. the shape panel), the area or
 * the island changes size. */
function useGeometry(islandRef) {
  const view = useStore((s) => s.view);
  const [geo, setGeo] = useState(null);
  useLayoutEffect(() => {
    const box = islandRef.current.parentElement;
    const bar = box.querySelector(':scope > .bottom-3.left-1\\/2'); // the toolbar island (editor view only)
    const measure = () => {
      const c = box.getBoundingClientRect();
      const v = viewportRect();
      const t = bar?.isConnected && bar.getBoundingClientRect();
      if (t) lastBottom = v.bottom - t.top + GAP;
      const bottom = c.bottom - v.bottom + (lastBottom ?? 4.5 * rem());
      setGeo({
        left: v.left + v.width / 2 - c.left,
        width: Math.max(24 * rem(), t ? t.width * 0.85 : v.width * 0.74),
        bottom,
        maxH: v.height * 0.25,
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of [box, bar, viewportRect().el]) if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [view]);
  return geo;
}

const ISLAND_MS = 190; // the island growing out of the mic for the restore button, or shrinking back into it
const ICON_MS = 100; // the restore icon fading in at the growth's end, or out at the shrink's start

function PttIsland({ islandRef }) {
  const d = useDictation();
  const restoreRef = useRef(null);
  // A workspace has its sidebar button in its header and its content starts at the left (Board columns, Backlog rows and
  // footer): the island sits at the bottom-right instead, compact (one row of small buttons) and translucent, clear of the
  // 10 px scrollbars and of the Backlog's rows.
  const view = useStore((s) => s.view);
  const workspace = !can('view.editor', { view });
  const size = workspace ? 'icon-xs' : 'icon-sm';
  const icon = workspace ? 'size-3.5' : undefined;
  const side = workspace ? 'top' : 'right';
  // The restore button sits above the mic (left of it in a workspace), so the mic never moves. When Minimize's sequence ends
  // the island's edge grows out from the mic to fit it and the icon fades in at the growth's end; while the pane opens again
  // the icon fades out and the island shrinks back into the mic (held there until the button goes when the pane is open).
  // A view change (the island's layout) meanwhile shows the step's end state at once, without motion.
  // The restore button only for a minimized pane with something in it (a transcript still on its way grows it when it lands).
  const phase = d.shown && (d.opening ? 'shrink' : d.minimized && !!(d.committed || d.partial || d.error) && 'grow');
  const lastPhase = useRef(false);
  useLayoutEffect(() => {
    const relayout = phase === lastPhase.current;
    lastPhase.current = phase;
    if (!phase || (relayout && phase === 'grow') || matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const isl = islandRef.current, btn = restoreRef.current;
    const dim = workspace ? 'width' : 'height';
    const full = `${isl.getBoundingClientRect()[dim]}px`;
    const small = `${isl.getBoundingClientRect()[dim] - btn.getBoundingClientRect()[dim] - parseFloat(getComputedStyle(isl).gap)}px`;
    const anims = phase === 'shrink'
      ? [isl.animate({ [dim]: [full, small], overflow: ['hidden', 'hidden'] }, { duration: ISLAND_MS, easing: 'ease-in', fill: 'forwards' }),
        btn.animate({ opacity: [1, 0] }, { duration: ICON_MS, easing: 'ease-in', fill: 'forwards' })]
      : [isl.animate({ [dim]: [small, full], overflow: ['hidden', 'hidden'] }, { duration: ISLAND_MS, easing: 'ease-out' }),
        btn.animate({ opacity: [0, 1] }, { delay: ISLAND_MS - ICON_MS, duration: ICON_MS, easing: 'ease-out', fill: 'backwards' })];
    if (relayout) anims.forEach((a) => a.finish());
    return () => anims.forEach((a) => a.cancel());
  }, [phase, workspace]);
  const restore = !!phase;
  return (
    <div ref={islandRef} data-dictation-island
      className={cn('absolute z-30 flex gap-1 rounded-island border shadow-lg', workspace
        ? 'right-4 bottom-3 flex-row-reverse bg-card/70 backdrop-blur-[2px]' : 'bottom-[calc(3.75rem+2px)] left-2 flex-col-reverse bg-card p-1')}>
      <Tip title={withKey('Hold to dictate', 'app.dictate')} side={side}>
        <Button variant="ghost" size={size} aria-label="Hold to dictate" data-agent-deny aria-pressed={d.recording} onPointerEnter={warm}
          className={cn(d.recording && 'bg-destructive/20 text-destructive hover:bg-destructive/25 hover:text-destructive')}
          {...hold(pttDown, pttUp)}>
          <Mic className={icon} />
        </Button>
      </Tip>
      {restore && (
        <Tip title="Show transcript" side={side}>
          <Button ref={restoreRef} variant="ghost" size={size} aria-label="Show transcript" inert={d.opening || undefined} onMouseDown={keep}
            onClick={() => minimize(false)}>
            <MessageSquareText className={icon} />
          </Button>
        </Tip>
      )}
    </div>
  );
}

const BARS = 28;

/** Live level bars from the microphone (newest on the right), drawn without re-rendering. */
function Waveform() {
  const ref = useRef(null);
  useEffect(() => {
    const levels = new Array(BARS).fill(0);
    let last = 0;
    let frame;
    const draw = (now) => {
      if (now - last > 45) {
        last = now;
        levels.shift();
        levels.push(Math.min(1, Math.sqrt(level()) * 2.2));
        ref.current?.childNodes.forEach((bar, i) => { bar.style.height = `${3 + levels[i] * 19}px`; });
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div ref={ref} data-waveform aria-hidden className="flex h-6 items-center gap-[3px]">
      {Array.from({ length: BARS }, (_, i) => <span key={i} className="h-[3px] w-[3px] rounded-full bg-foreground/80" />)}
    </div>
  );
}

/** "Dismiss": closes the pane only after a 3 s hold, filling left to right meanwhile; an early release resets it. */
function DismissButton() {
  const [held, setHeld] = useState(false);
  const timer = useRef(null);
  const down = () => {
    setHeld(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(dismiss, DISMISS_MS);
  };
  const up = () => {
    clearTimeout(timer.current);
    setHeld(false);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Tip title="Hold 3 seconds to close" side="top">
      <Button variant="outline" size="xs" aria-label="Dismiss (hold 3 seconds)" className="relative overflow-hidden rounded-full px-3"
        {...hold(down, up)}>
        <span aria-hidden data-dismiss-fill style={{ transitionDuration: held ? `${DISMISS_MS}ms` : '0ms' }}
          className={cn('absolute inset-0 origin-left bg-destructive/45 transition-transform ease-linear', held ? 'scale-x-100' : 'scale-x-0')} />
        <span className="relative">Dismiss</span>
      </Button>
    </Tip>
  );
}

function Pane({ geo }) {
  const d = useDictation();
  const paneRef = useRef(null);
  const podRef = useRef(null);
  const cardRef = useRef(null);
  const textRef = useRef(null);
  const scrollRef = useRef(null);
  const [textH, setTextH] = useState(0);
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setTextH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [d.shown]);
  useEffect(() => { // new text (also the final pass after release): show its end
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [d.committed, d.partial, textH]);
  const text = !!(d.committed || d.partial || d.error);
  // The close sequence (dictation.js CLOSE_STEPS), played over the shown pane while `closing`: the card narrows to the pod's
  // width (its text fading first), its height falls (its bottom stays on the column's bottom, so the pod comes down with its
  // top), the pod narrows to a circle (its controls fading), then fades out while shrinking as the pane gives up its place in
  // the column (the notice stack comes down to the column's bottom). While `opening` (restore) it plays backwards, each step
  // mirrored in time (ease-in-out is symmetric). Cancelled with `closing` / `opening`: a new press shows the pane at once, and
  // the end hides it (or leaves it open) in the same frame.
  const moving = d.closing || d.opening;
  useLayoutEffect(() => {
    if (!moving) return undefined;
    const [narrow, fold, round, fade] = CLOSE_STEPS;
    const pane = paneRef.current, pod = podRef.current, card = cardRef.current, scroll = scrollRef.current;
    const px = (n) => `${n}px`;
    // Measured before any animation applies (a reversed one shows its end state at once), unrounded.
    const [paneR, scrollR, podR, cardR] = [pane, scroll, pod, card].map((el) => el.getBoundingClientRect());
    const folded = podR.height / 2 + 2; // the card's least height: its top padding and borders, behind the pod's lower half
    const lead = text ? narrow + fold : 0; // without text the card is hidden already (and at its least height)
    const total = lead + round + fade;
    const play = (el, keyframes, delay, duration) => el.animate(keyframes, d.opening
      ? { delay: total - delay - duration, duration, easing: 'ease-in-out', fill: 'both', direction: 'reverse' }
      : { delay, duration, easing: 'ease-in-out', fill: 'both' });
    const hold = (el, prop, value) => play(el, { [prop]: [value, value] }, 0, total);
    const anims = [
      hold(scroll, 'width', px(scrollR.width)), // the text is clipped, not reflowed
      text ? play(scroll, { opacity: [1, 0] }, 0, narrow * 0.45) : hold(card, 'opacity', 0),
      play(pod, { width: [px(podR.width), px(podR.height)] }, lead, round),
      play(pod.firstChild, { opacity: [1, 0] }, lead, round * 0.6),
      play(pod, { opacity: [1, 0], transform: ['scale(1)', 'scale(0.8)'] }, lead + round, fade),
      // the folded pane's height and the gap above it: the pod stays put while the stack comes down over it
      play(pane, { marginTop: [px(0), px(-(paneR.height - cardR.height + folded + GAP))] }, lead + round, fade),
    ];
    if (text) {
      anims.push(play(card, { width: [px(cardR.width), px(podR.width)] }, 0, narrow),
        // down to its least height, fading out over the fold's end behind the pod
        play(card, [{ height: px(cardR.height), opacity: 1 }, { opacity: 1, offset: 0.6 }, { height: px(folded), opacity: 0 }], narrow, fold));
    } else if (d.closing) {
      anims.push(hold(card, 'height', px(cardR.height))); // text arriving meanwhile (a final pass) neither lifts the pod nor the stack
    }
    return () => anims.forEach((a) => a.cancel());
  }, [d.closing, d.opening]);
  // The card hides behind the pod's lower half until text arrives, then grows upward (its bottom stays put).
  const height = text ? Math.min(geo.maxH, textH + 2.5 * rem() + 2) : 1.25 * rem();
  if (!d.shown) return null;
  // In the bottom column's flow, under the notice stack, which follows its top. Minimized it leaves the flow (hidden, inert).
  return (
    <div ref={paneRef} data-dictation-pane role="region" aria-label="Dictation" aria-hidden={d.minimized || undefined} inert={d.minimized || undefined}
      className={cn('pointer-events-none z-30 flex w-full flex-col items-center', d.minimized ? 'invisible absolute inset-x-0 bottom-0' : 'relative')}>
      {/* The controls keep their width while the pod narrows over them (centred, clipped). */}
      <div ref={podRef} data-pod className={cn('relative z-10 flex h-10 w-[24rem] max-w-full shrink-0 justify-center overflow-hidden rounded-full border bg-card shadow-lg',
        !moving && 'pointer-events-auto')}>
        <div className="flex w-[calc(24rem-2px)] shrink-0 items-center justify-between gap-2 px-1.5">
          <Tip title="Minimize" side="top">
            <Button variant="ghost" size="icon-sm" aria-label="Minimize" className="rounded-full" onMouseDown={keep} onClick={() => minimize(true)}>
              <Minimize2 />
            </Button>
          </Tip>
          {d.recording ? <Waveform /> : <MicOff aria-label="Microphone off" className="size-4 text-muted-foreground" />}
          <DismissButton />
        </div>
      </div>
      {/* The pane's box is wider than the pod: only the pod and a shown card take the pointer, the rest clicks through. */}
      <div ref={cardRef} data-dictation-card className={cn('-mt-5 w-full overflow-hidden rounded-xl border bg-card/85 pt-5 shadow-xl backdrop-blur-sm',
        text && 'transition-[height] duration-300 ease-out', text && !moving && 'pointer-events-auto')}
        style={{ height, opacity: text ? 1 : 0 }}>
        <div ref={scrollRef} className="h-full overflow-y-auto px-4 pt-2 pb-3">
          <div ref={textRef} data-transcript className="cursor-text text-center text-sm break-words whitespace-pre-wrap select-text">
            {d.committed}
            {d.committed && d.partial ? ' ' : ''}
            {d.partial && <span className="text-foreground/65">{d.partial}</span>}
            {d.error && <p className="text-destructive">{d.error}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

const Radio = ({ name, value, checked, onChange, children }) => (
  <label className="flex cursor-pointer items-start gap-2 rounded-md p-1 hover:bg-accent/50">
    <input type="radio" name={name} value={value} checked={checked} onChange={() => onChange(value)} className="mt-0.5 accent-primary" />
    <span className="grid gap-0.5">{children}</span>
  </label>
);

/** First-use setup: what is downloaded, the model (the stored one preselected, Small by default; each one's pros and cons),
 * English or Automatic. */
function InstallForm({ open }) {
  const [model, setModel] = useState(open.model);
  const [language, setLanguage] = useState(open.language);
  const [status, setStatus] = useState(null);
  const [phase, setPhase] = useState('choose'); // 'choose' | 'download' | 'error'
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(null);
  useEffect(() => {
    let live = true;
    window.api.dictation.status({ model }).then((s) => live && setStatus(s), (e) => live && setError(String(e.message || e)));
    return () => { live = false; };
  }, [model]);
  useEffect(() => window.api.dictation.onProgress(setProgress), []);
  const busy = phase === 'download';
  const start = async () => {
    setPhase('download');
    setProgress(null);
    setError('');
    try {
      await install(model, language);
    } catch (e) {
      if (getState().dictationInstall !== open) return;
      setPhase('error');
      setError(e.message === 'cancelled' ? 'The download was cancelled.' : e.message);
    }
  };
  const cancel = () => {
    if (busy) cancelInstall();
    closeInstall(null);
  };
  const total = status ? status.missing.reduce((n, m) => n + m.bytes, 0) : 0;
  const other = !['en', 'auto'].includes(open.language) && LANGUAGES.find(([code]) => code === open.language);
  const pct = progress?.total ? Math.round((progress.received / progress.total) * 100) : 0;
  return (
    <Dialog open onOpenChange={(o) => !o && cancel()}>
      <DialogContent aria-describedby={undefined} onInteractOutside={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => !getState().dialog && refocusEditor(e)}
        className="max-h-[88vh] gap-2 overflow-y-auto p-3 text-sm sm:max-w-[min(560px,92vw)] *:data-[slot=dialog-close]:top-3 *:data-[slot=dialog-close]:right-3">
        <DialogHeader><DialogTitle className="text-base">Set up dictation</DialogTitle></DialogHeader>
        <p className="text-muted-foreground">
          Dictation turns speech into text on this computer with whisper.cpp; no audio leaves it. Downloaded once into the app's data folder
          (all MIT licensed):
        </p>
        <ul className="grid list-disc gap-0.5 pl-5">
          <li>whisper.cpp server, CPU build: GitHub, ggml-org/whisper.cpp release file whisper-bin-x64.zip (about 9 MB)</li>
          <li>Speech model: Hugging Face, ggerganov/whisper.cpp (size below)</li>
          <li>Voice activity model ggml-silero-v5.1.2.bin: Hugging Face, ggml-org/whisper-vad (1 MB)</li>
        </ul>
        <fieldset disabled={busy} className="grid gap-0.5">
          <legend className="mb-0.5 font-semibold">Model</legend>
          {(status?.models ?? []).map((m, i) => (
            <Radio key={m.id} name="dictation-model" value={m.id} checked={model === m.id} onChange={setModel}>
              <span>{m.label} ({mb(m.bytes)}){i === 0 && ', the default'}{m.downloaded && ', downloaded'}</span>
              <span className="text-xs text-muted-foreground">{m.note}</span>
            </Radio>
          ))}
          <p className="text-xs text-muted-foreground">
            Small suits most computers. Pick Best quality only if you want fewer mistakes and your computer has the space and speed
            for it, and Base only if storage or speed requires it.
          </p>
        </fieldset>
        <fieldset disabled={busy} className="grid gap-0.5">
          <legend className="mb-0.5 font-semibold">Language</legend>
          <Radio name="dictation-language" value="en" checked={language === 'en'} onChange={setLanguage}><span>English</span></Radio>
          {other && <Radio name="dictation-language" value={other[0]} checked={language === other[0]} onChange={setLanguage}><span>{other[1]}</span></Radio>}
          <Radio name="dictation-language" value="auto" checked={language === 'auto'} onChange={setLanguage}>
            <span>Automatic</span>
            <span className="text-xs text-muted-foreground">
              Detects the language each time. Short or accented phrases can be taken for another language and come out in it.
            </span>
          </Radio>
          <p className="text-xs text-muted-foreground">Both can be changed later in Settings, which lists every language the model knows.</p>
        </fieldset>
        {busy && (
          <div className="grid gap-1" role="status">
            <span>
              {progress ? `Downloading the ${progress.label} (${progress.step} of ${progress.steps})` : 'Starting...'}
              {progress?.total ? `: ${mb(progress.received)} of ${mb(progress.total)}` : ''}
            </span>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}
        {error && <p className="text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={cancel}>Cancel</Button>
          <Button type="button" size="sm" disabled={busy || !status} onClick={start}>
            {phase === 'error' ? 'Retry' : total ? `Download and install (${mb(total)})` : 'Use this model'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Settings > Dictation's downloaded models: each with its size and "In use", and Delete, confirmed; for the model in use the
 * confirmation asks which other downloaded model to switch to (`selected`, the dialog's model, preselected when it is one),
 * or says that dictation turns off. Lists again when `version` changes; `onChange(patch)` after a deletion, with the
 * settings.dictation patch it saved (or null). */
export function ModelFiles({ selected, version, onChange }) {
  const [files, setFiles] = useState(null);
  const [asking, setAsking] = useState(null); // {model, others, to} while the confirmation is open
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    window.api.dictation.listModels().then((list) => live && setFiles(list), (e) => live && setError(String(e.message || e)));
    return () => { live = false; };
  }, [version]);
  const ask = (m) => {
    const others = modelInUse(m.id) ? files.filter((o) => o.id !== m.id) : [];
    setAsking({ model: m, others, to: (others.find((o) => o.id === selected) ?? others[0])?.id });
  };
  const remove = async () => {
    const { model: m, to } = asking;
    setAsking(null);
    setError('');
    let patch = null;
    try {
      patch = await deleteModel(m.id, to);
    } catch (e) {
      setError(`${m.file} was not deleted: ${e.message}`);
    }
    onChange(patch);
  };
  const m = asking?.model;
  const inUse = m && modelInUse(m.id);
  return (
    <div className="grid gap-1" data-dictation-models>
      {!files ? 'Checking...' : !files.length && <span className="text-muted-foreground">None</span>}
      {files?.map((f) => (
        <div key={f.id} data-model={f.id} className="flex items-center gap-2">
          <span>{f.label}</span>
          <span className="text-muted-foreground">{f.file}, {mb(f.bytes)}</span>
          {modelInUse(f.id) && <Badge variant="secondary">In use</Badge>}
          <Button type="button" variant="outline" size="xs" aria-label={`Delete ${f.file}`} onClick={() => ask(f)}>Delete</Button>
        </div>
      ))}
      {error && <p className="text-destructive">{error}</p>}
      {m && (
        <AlertDialog open onOpenChange={(o) => !o && setAsking(null)}>
          <AlertDialogContent className="gap-2 p-3">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-base">Delete the {m.label} model ({mb(m.bytes)})?</AlertDialogTitle>
              <AlertDialogDescription>
                {!inUse ? `${m.file} is removed from this computer. It can be downloaded again later.`
                  : asking.others.length ? 'Dictation uses it. Switch dictation to:'
                    : 'Dictation uses it and no other model is downloaded: dictation turns off until you install a model again.'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {inUse && asking.others.map((o) => (
              <Radio key={o.id} name="dictation-switch" value={o.id} checked={asking.to === o.id} onChange={(to) => setAsking({ ...asking, to })}>
                <span>{o.label} ({mb(o.bytes)})</span>
              </Radio>
            ))}
            <AlertDialogFooter>
              <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
              <AlertDialogAction size="sm" variant="destructive" onClick={remove}>Delete model</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

function InstallDialog() {
  const open = useStore((s) => s.dictationInstall);
  return open ? <InstallForm key={open.id} open={open} /> : null;
}

/** Everything dictation shows, mounted once in the main column's area (it measures that area, the page's viewport and the
 * toolbar island). `children` (the §7c notice stack) rest on the pane in the bottom column: its bottom is pinned and its
 * children are in normal flow, so the stack follows the pane's top in every frame. The column itself takes no pointer and
 * makes no stacking context (no z-index, no transform): the pane (z-30) and the stack (z-40) layer with the rest of the area. */
export function Dictation({ children }) {
  const islandRef = useRef(null);
  const geo = useGeometry(islandRef);
  // The Hold to dictate chord (default Ctrl+Shift+D, §7k) holds to talk from anywhere (window capture, not while a dialog is
  // open): down starts a session as the mic button does, releasing its key or one of its modifiers ends it, as does the window
  // losing the focus (the key-up never arrives then).
  useEffect(() => {
    let held = null; // the held key event's {code, ctrl, shift, alt}
    const up = () => { if (held) { held = null; pttUp(); } };
    const onDown = (e) => {
      if (!keyIs('app.dictate', e)) return;
      const st = getState();
      if (st.dialog || st.confirm) return;
      e.preventDefault();
      e.stopPropagation();
      if (held || e.repeat) return;
      held = { code: e.code, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey };
      pttDown();
    };
    const onUp = (e) => held && (e.code === held.code || (held.ctrl && (e.key === 'Control' || e.key === 'Meta'))
      || (held.shift && e.key === 'Shift') || (held.alt && e.key === 'Alt')) && up();
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('blur', up);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('blur', up);
      up();
    };
  }, []);
  return (
    <>
      <PttIsland islandRef={islandRef} />
      {geo && (
        <div data-bottom-column className="pointer-events-none absolute flex flex-col items-center"
          style={{ left: geo.left - geo.width / 2, bottom: geo.bottom, width: geo.width, gap: GAP }}>
          {children}
          <Pane geo={geo} />
        </div>
      )}
      <InstallDialog />
    </>
  );
}
