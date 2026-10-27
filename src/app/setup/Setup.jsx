// The setup on the first start (docs/plans/onboarding.md): one modal dialog, a page at a time (pages.jsx PAGES, then the
// SetupPages of the integrations that are on, then `finish`). It shows while settings.onboarded is not true, or after Run
// setup again (state.setup); never in the background window (§7i) or the smoke sample run. Neither Escape nor a click
// outside closes it. Each move saves settings.setup {step, usedBefore}, so a restart reopens it at that page; Start writing
// saves onboarded: true.
import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { setupPages } from '../../integrations/ui.js';
import { refocusEditor, saveSettings, setupOpen } from '../actions.js';
import { Help } from '../components/Tip.jsx';
import { setState, useStore } from '../store.js';
import { after, before, leave, resumeAt, stepLabel } from './flow.mjs';
import { PAGES } from './pages.jsx';
import { AutoHeight, SETUP_PLACE } from './shared.jsx';

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])';
const keep = (e) => e.preventDefault();

/** The setup dialog (one, mounted in App). */
export function Setup() {
  return useStore(setupOpen) ? <Flow /> : null;
}

function Flow() {
  const settings = useStore((s) => s.settings);
  // Integration pages (integrations/ui.js setupPages) after the app's own, before `finish`; each is a step of its own, its
  // id prefixed with its integration's.
  const list = [
    ...PAGES.slice(0, -1),
    ...setupPages(settings).map((p) => ({ id: `${p.integration}.${p.id}`, step: `${p.integration}.${p.id}`, title: p.title, help: p.help, Page: p.Page, integration: true })),
    PAGES.at(-1),
  ];
  const [id, setId] = useState(() => settings.setup?.step);
  const [usedBefore, setUsedBefore] = useState(settings.setup?.usedBefore ?? null);
  const history = useRef([]); // the pages Continue came from, for Back
  // What the page shown set for the bar, kept with its page's id, so a page never gets the last page's.
  const [nav, setNav] = useState({ at: null });
  const [busy, setBusy] = useState({ at: null });
  const [done, setDone] = useState({ at: null });
  const here = resumeAt(list, id);
  const page = list.find((p) => p.id === here);
  const body = useRef(null);
  const cont = useRef(null);

  const save = (step, used = usedBefore) => saveSettings({ setup: { step, usedBefore: used } }).catch(() => {});
  const go = (to, push = true) => {
    if (!to) return;
    if (push) history.current.push(here);
    setId(to);
    save(to);
  };
  const props = {
    next: (to) => go(to ?? after(list, here)),
    back: () => go(history.current.pop() ?? before(list, here), false),
    setBusy: (on) => setBusy({ at: here, on: !!on }),
    setDone: (on) => setDone({ at: here, on: !!on }),
  };
  // The app's own pages get more than the integration contract: the bar, leaving a step, the welcome answer and finishing.
  const own = page.integration ? {} : {
    setNav: (n) => setNav({ ...n, at: here }),
    leave: () => go(leave(list, here)),
    usedBefore,
    setUsedBefore: (v) => {
      setUsedBefore(v);
      save(here, v);
    },
    finish: async () => {
      await saveSettings({ onboarded: true, setup: { step: here, usedBefore } });
      setState({ setup: false });
    },
  };
  const n = nav.at === here ? nav : {};
  const working = busy.at === here && busy.on;
  // An integration page with its own primary action reads Skip until it calls setDone(true).
  const label = n.label ?? (page.integration && !(done.at === here && done.on) ? 'Skip' : 'Continue');
  const onContinue = async () => {
    setBusy({ at: here, on: true });
    try {
      await (n.go ?? props.next)();
    } finally {
      setBusy((b) => (b.at === here ? { at: here, on: false } : b));
    }
  };

  // Each page starts with the focus on its first control (else on Continue). A page that draws its controls later (the
  // GitHub pages wait for github.status), or sets Continue from an effect, gets it once it shows, while the focus still
  // sits on nothing, the dialog or Continue.
  useEffect(() => {
    const box = body.current?.closest('[data-setup]');
    const place = (force) => {
      if (!force && ![document.body, box, cont.current].includes(document.activeElement)) return watch.disconnect();
      const el = body.current?.querySelector(FOCUSABLE);
      if (el) {
        el.focus();
        watch.disconnect();
      } else if (cont.current && !cont.current.disabled) cont.current.focus();
    };
    const watch = new MutationObserver(() => place());
    const t = setTimeout(() => {
      box && watch.observe(box, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
      place(true);
    });
    return () => {
      clearTimeout(t);
      watch.disconnect();
    };
  }, [here]);

  const Page = page.Page;
  return (
    <Dialog open>
      <DialogContent showCloseButton={false} onEscapeKeyDown={keep} onInteractOutside={keep} onCloseAutoFocus={refocusEditor}
        {...(!page.help && { 'aria-describedby': undefined })} data-setup={here}
        className={cn('gap-4 overflow-y-auto rounded-island bg-island p-5 text-sm sm:max-w-[36rem]', SETUP_PLACE)}>
        <div className="grid gap-1.5">
          <p className="text-xs text-muted-foreground" data-setup-step>{stepLabel(list, here)}</p>
          <div className="flex items-center gap-1.5">
            <DialogTitle className="text-lg">{page.title}</DialogTitle>
            {page.help && <Help>{page.help}</Help>}
          </div>
          {page.help && <DialogDescription className="sr-only">{page.help}</DialogDescription>}
        </div>
        <AutoHeight>
          <div ref={body} key={here} className="grid animate-page-in content-start gap-3">
            <Page {...props} {...own} />
          </div>
        </AutoHeight>
        <div className="flex items-center gap-2">
          {here !== list[0].id && <Button variant="ghost" size="sm" disabled={working} onClick={props.back}>Back</Button>}
          <div className="ml-auto flex items-center gap-2">
            {n.skip && <Button variant="ghost" size="sm" onClick={n.skip.go}>{n.skip.label}</Button>}
            {!n.hidden && <Button ref={cont} size="sm" disabled={working || !!n.disabled} onClick={onContinue} data-setup-continue>{label}</Button>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
