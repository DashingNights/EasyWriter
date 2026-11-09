// The File tab's backstage view (docs/plans/word/plan.md §1.4 BACKSTAGE, §1.12 store word.backstage, §2.8): Word's left
// navigation in its order with data-keytip on each entry, Back first; a page entry shows its page from the modules
// (backstagePage) or a placeholder page with its reason; a command entry closes the backstage and runs its command, as does a
// page entry whose page is not built while a command of its id is (New runs today's new draft).
// Word's backstage covers the window; here it is a modal page (direction.md 6): the dialog kit's modal (backdrop, focus trap)
// over the page area only, sized to it less a margin. Escape or Back returns to the document.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from 'cn';
import { ArrowLeft } from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import { refocusEditor } from '../../app/actions.js';
import { CHROME } from '../../app/components/board/controls.jsx';
import { getState, useStore } from '../../app/store.js';
import { REASONS } from '../../tooling/reasons.mjs';
import { backstagePage, commandOf, run } from '../../tooling/registry.js';
import { setWord } from '../../tooling/ribbon/contexts.js';

/** Opens the backstage on page `id` ('file.info'); no id opens its first page; null closes it and gives the editor the focus. */
export function openBackstage(id) {
  const open = getState().word?.backstage;
  setWord({ backstage: id === null ? null : id ?? 'first', peek: false });
  if (id === null && open) requestAnimationFrame(() => refocusEditor());
}

const isBack = (e) => e.id === 'file.back';
const GAP = 16; // the modal page's margin inside the page area

/** While `on`: the page area (the main column right of the sidebar, below its title row, which keeps the window's drag region
 * and controls) as a fixed box, and the modal page's box inside it: the page area less GAP on each side. */
function usePageBoxes(on) {
  const [boxes, setBoxes] = useState(null);
  useLayoutEffect(() => {
    if (!on) return undefined;
    const main = document.querySelector('main');
    const measure = () => {
      const a = main.getBoundingClientRect();
      const top = Math.max(a.top, document.querySelector('[data-titlebar]')?.getBoundingClientRect().bottom ?? a.top);
      const height = a.bottom - top;
      setBoxes({ area: { left: a.left, top, width: a.width, height },
        page: { left: a.left + GAP, top: top + GAP, width: a.width - 2 * GAP, height: height - 2 * GAP } });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(main);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [on]);
  return on ? boxes : null;
}

/** The backstage for `spec` (its BACKSTAGE list). App.jsx mounts it while a Document is open; it draws nothing while closed. */
export function Backstage({ spec }) {
  const want = useStore((s) => s.word?.backstage ?? null);
  const nav = useRef(null);
  const entries = (spec.BACKSTAGE ?? []).filter((e) => !isBack(e));
  const pages = entries.filter((e) => e.kind === 'page');
  const page = want === 'first' ? pages[0] : pages.find((e) => e.id === want) ?? pages[0];
  const boxes = usePageBoxes(!!want);
  // App unmounts this when the Document closes or the view leaves the editor: the backstage closes with it, so it does not
  // come back by itself with the next Document.
  useEffect(() => () => getState().word?.backstage && setWord({ backstage: null }), []);
  if (!want || !boxes) return null;
  const Page = page && backstagePage(page.id);
  const runs = (e) => !e.needs && (e.kind === 'command' || !backstagePage(e.id)) && !!commandOf(e.id);
  const pick = (e) => {
    if (!runs(e)) return openBackstage(e.id);
    openBackstage(null);
    run(e.id);
  };
  const back = spec.BACKSTAGE?.find(isBack);
  // The entry of the page shown takes the focus on open (Back otherwise); openBackstage(null) gives it back to the editor.
  const first = (e) => {
    e.preventDefault();
    nav.current?.querySelector('[aria-current="page"], button')?.focus();
  };
  return (
    <D.Root open modal onOpenChange={(open) => !open && openBackstage(null)}>
      <D.Portal>
        <D.Overlay data-backstage-backdrop="" style={boxes.area} className="fixed z-50 bg-black/50" />
        <D.Content {...CHROME} data-backstage={page?.id ?? ''} aria-describedby={undefined} style={boxes.page} onOpenAutoFocus={first}
          onCloseAutoFocus={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}
          className="fixed z-50 flex overflow-hidden rounded-lg border bg-background text-foreground shadow-lg outline-none">
          <D.Title className="sr-only">File</D.Title>
          <nav ref={nav} aria-label="File" className="flex w-44 shrink-0 flex-col gap-1 border-r p-2 text-sm">
            <Button type="button" variant="ghost" size="icon-sm" data-feature={back?.id ?? 'file.back'} data-keytip={back?.keytip} aria-label="Back" onClick={() => openBackstage(null)} className="mb-2 rounded-full">
              <ArrowLeft />
            </Button>
            {entries.map((e) => {
              const off = e.kind === 'command' && !runs(e);
              return (
                <Button key={e.id} type="button" variant="ghost" size="sm" data-feature={e.id} data-keytip={e.keytip} aria-current={e === page ? 'page' : undefined}
                  aria-disabled={off || undefined} title={off ? REASONS[e.needs] ?? REASONS.pending : undefined} onClick={() => !off && pick(e)}
                  className={cn('justify-start text-muted-foreground aria-disabled:opacity-40 aria-[current=page]:bg-accent aria-[current=page]:text-accent-foreground', e.id === 'file.account' && 'mt-auto')}>
                  {e.label}
                </Button>
              );
            })}
          </nav>
          <section aria-label={page?.label} className="min-w-0 flex-1 overflow-auto px-10 py-8">
            <h1 className="mb-6 text-base leading-none font-semibold">{page?.label}</h1>
            {Page ? <Page close={() => openBackstage(null)} go={openBackstage} />
              : <p className="text-sm text-muted-foreground">{REASONS[page?.needs] ?? REASONS.pending}</p>}
          </section>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
