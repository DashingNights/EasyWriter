// Word's status bar (briefs/statusbar.md, index-layout.md Status bar): while a Document is open in the editor view, the app's own
// status bar (StatusBar.jsx) renders this in its place, with its spell check, save state and agent items around Word's and Word's
// zoom instead of its own. Word's items in Word's order, each shown or hidden through Customize Status Bar (settings.word.statusBar);
// a right-click anywhere on the bar opens that checklist.
import { isValidElement, memo, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from 'cn';
import { Accessibility, Book, BookCheck, BookOpen, BookX, FileText, Focus, Globe, Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Slider } from '@/components/ui/slider';
import { previewZoom, refocusEditor, settleZoom } from '../../../app/actions.js';
import { useLiveZoom } from '../../../app/livezoom.js';
import { Tip } from '../../../app/components/Tip.jsx';
import { getState, useEditor, useStore } from '../../../app/store.js';
import { useUnit } from '../../../tooling/kit/controls.jsx';
import { AccessText, accessProps } from '../../../tooling/kit/WordDialog.jsx';
import { REASONS } from '../../../tooling/reasons.mjs';
import { commandOf, ctxOf, run } from '../../../tooling/registry.js';
import { activeSurface } from '../../../tooling/surface.js';
import { geometryOf, paginationKey } from '../../geometry.js';
import { sectionAt, sectionsOf } from '../../model/sections.mjs';
import { saveWord, wordSettings } from '../../word/settings.mjs';
import { measureCaret } from './caret.js';
import { ZERO } from './count.mjs';
import { docCounts, rangeCounts } from './docCount.mjs';
import { charsText, ITEMS, languageName, MODE_TEXT, positionText, PROMPT_TEXT, wordsText } from './items.mjs';
import { pctToPos, posToPct } from './zoomScale.mjs';

/** Opens Customize Status Bar at a client point; the mounted bar sets it (the statusBar.customize command calls it). */
export const customize = { open: () => false };

const NO_CARET = { vertical: null, line: null, column: null };
const keep = (e) => e.preventDefault(); // a press on the bar leaves the focus and the caret in the page

/** Shows or hides item `key` (Customize Status Bar). */
export const toggleItem = (key, settings) => saveWord({ statusBar: { [key]: !wordSettings(settings).statusBar[key] } });

/** A command's value(ctx) (proofing's flagged words, the checker's issues), or null while the command or its value is missing. */
function valueOf(id) {
  try {
    const c = commandOf(id);
    return c?.value ? c.value(ctxOf()) ?? null : null;
  } catch {
    return null;
  }
}

/** Caps Lock as the last key or mouse event reported it. A focus event carries no modifier state, so a change made while the window
 * was in the background shows on the next mouse move over it. */
function useCapsLock() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const read = (e) => {
      if (typeof e.getModifierState === 'function') setOn(e.getModifierState('CapsLock'));
    };
    const types = ['keydown', 'keyup', 'mousedown', 'mousemove']; // the same value again does not re-render
    for (const t of types) window.addEventListener(t, read, true);
    return () => {
      for (const t of types) window.removeEventListener(t, read, true);
    };
  }, []);
  return on;
}

const sameSel = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const countsOf = (v) => (v ? { words: v.words ?? 0, chars: v.characters ?? 0, charsSp: v.charactersWithSpaces ?? 0, paras: v.paragraphs ?? 0 } : ZERO);

// The values each of useEngineCounts' `shown` names draws (a selection's part only when there is one, as wordsText shows it).
const SHOWN = {
  page: (c) => c.page,
  pages: (c) => c.pages,
  section: (c) => c.section,
  words: (c) => [c.total.words, c.part ? c.part.words : null],
  chars: (c) => [c.total.charsSp, c.part ? c.part.charsSp : null],
};

/** On a canvas draft (`session`, its SessionClient), the page and count items read the engine, since the draft's ProseMirror doc
 * is stale: the caret's page, the page count and review.wordCount, for the document and, with a selection, for it. Read a moment
 * after each layout or selection change → {page, pages, section (the caret page's), total, part} or null. A read that changes
 * none of the values `shown` names (SHOWN's keys, space-separated: what the bar draws) keeps the last counts, so the bar does
 * not render again for them (engine-main-thread-2: every letter changed the character count the bar hides by default). */
function useEngineCounts(session, countNotes, shown) {
  const [c, setC] = useState(null);
  const want = useRef(shown);
  const again = useRef(null);
  want.current = shown;
  // Values shown since the last read (Customize Status Bar lists them all) are read at once.
  // Braces: the read's promise must not be the effect's return, or React calls it as the cleanup and the app stops.
  useEffect(() => {
    again.current?.();
  }, [shown]);
  useEffect(() => {
    setC(null);
    if (!session) return undefined;
    let live = true;
    let timer = 0;
    let total = null; // the document's counts, read while the selection is empty
    const read = async () => {
      const [sel, pages, wc] = await Promise.all([session.selection(), session.pages(), session.query('review.wordCount', { includeTextBoxes: countNotes })]);
      const at = sel ? await session.caret(sel.head) : null;
      if (!live) return;
      const empty = !sel || sameSel(sel.anchor, sel.head);
      if (empty) total = countsOf(wc?.value);
      const list = pages?.pages ?? [];
      const n = at?.page ?? 0;
      const next = { page: n + 1, pages: Math.max(1, list.length), section: (list[n]?.section ?? 0) + 1, total: total ?? ZERO, part: empty ? null : countsOf(wc?.value) };
      const drawn = (x) => JSON.stringify(want.current.split(' ').filter(Boolean).map((k) => SHOWN[k](x)));
      setC((was) => (was && drawn(was) === drawn(next) ? was : next));
    };
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(() => read().catch(() => {}), 150);
    };
    const offs = ['layout', 'selection', 'reopened'].map((e) => session.on?.(e, later));
    later();
    again.current = () => read().catch(() => {});
    return () => {
      live = false;
      again.current = null;
      clearTimeout(timer);
      for (const off of offs) off?.();
    };
  }, [session, countNotes]);
  return c;
}

/** The caret measures `want` asks for, taken once per frame after a transaction or a zoom change, and only while asked. */
function useCaret(ed, want, zoomPct) {
  const [m, setM] = useState(NO_CARET);
  const key = ['verticalPosition', 'lineNumber', 'column'].filter((k) => want[k]).join(' ');
  useEffect(() => {
    if (!ed || !key) {
      setM(NO_CARET);
      return undefined;
    }
    const asked = Object.fromEntries(key.split(' ').map((k) => [k, true]));
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next = measureCaret(ed.view, asked);
      setM((prev) => (prev.vertical === next.vertical && prev.line === next.line && prev.column === next.column ? prev : next));
    };
    // The pagination frame was asked for during the transaction, so this one runs after it and sees the new layout.
    const schedule = () => {
      frame ||= requestAnimationFrame(measure);
    };
    schedule();
    ed.on('transaction', schedule);
    return () => {
      cancelAnimationFrame(frame);
      ed.off('transaction', schedule);
    };
  }, [ed, key, zoomPct]);
  return m;
}

/** A menu item label with Word's access key: underlined, and pressed by its letter while the menu is open (PointMenu). */
const Access = ({ label }) => <span {...accessProps(label)}><AccessText label={label} /></span>;

/** A letter that is an item's access key presses that item, as in Word's menus (Radix would only jump to the first match). */
function pressAccess(e) {
  if (e.altKey || e.ctrlKey || e.metaKey || e.key.length !== 1) return;
  const key = e.key.toLowerCase();
  const item = [...e.currentTarget.querySelectorAll('[data-access]')].find((el) => el.dataset.access === key)?.closest('[role^="menuitem"]');
  if (!item) return;
  e.preventDefault();
  if (!item.hasAttribute('data-disabled')) item.click();
}

/** A dropdown menu at client point `at` from a 0 x 0 trigger there. */
function PointMenu({ at, onClose, label, feature, children }) {
  return (
    <DropdownMenu open onOpenChange={(open) => !open && onClose()}>
      {createPortal(
        <DropdownMenuTrigger asChild>
          <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: at.x, top: at.y }} />
        </DropdownMenuTrigger>,
        document.body,
      )}
      <DropdownMenuContent side="top" align="start" sideOffset={2} className="min-w-64 text-xs" aria-label={label} data-feature={feature}
        onCloseAutoFocus={refocusEditor} onKeyDown={pressAccess}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Opens Word Options on its Proofing page, or runs File > Options (its placeholder) while the dialog is not registered. */
async function proofingOptions() {
  const { WORD_DIALOGS } = await import('../../../tooling/dialogs.js'); // late: that module imports the hub this module is part of
  if (WORD_DIALOGS.wordOptions) ctxOf().dialog('wordOptions', { tab: 'proofing' });
  else run('file.options');
}

/** Whether Item's props `a` and `b` draw the same: its handlers only run commands or open the bar's menus, so a new function in
 * place of one draws and does the same, and its children (text, an icon) are compared by what they are. A bar that renders for
 * its other items (or for StatusBar's around it) leaves an item whose content did not change alone, with its tooltip and button
 * (engine-main-thread-2: two thirds of a key's renders). */
function sameItem(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every((k) => (typeof a[k] === 'function' ? typeof b[k] === 'function' : sameNode(a[k], b[k])));
}
const sameNode = (a, b) => Object.is(a, b)
  || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameNode(x, b[i])))
  || (isValidElement(a) && isValidElement(b) && a.type === b.type && a.key === b.key && sameItem(a.props, b.props));

/** One item: a button when it does something on a click, else plain text. */
const Item = memo(function Item({ k, tip, onClick, onContextMenu, pressed, className, children }) {
  const feature = `statusBar.${k}`;
  if (!onClick) {
    return <span data-feature={feature} className={cn('whitespace-nowrap tabular-nums', className)}>{children}</span>;
  }
  return (
    <Tip title={tip} side="top">
      <Button variant="ghost" size="xs" data-feature={feature} aria-pressed={pressed} onMouseDown={keep} onClick={onClick}
        onContextMenu={onContextMenu} className={cn('-mx-1 font-normal whitespace-nowrap text-muted-foreground tabular-nums', pressed && 'bg-accent text-foreground', className)}>
        {children}
      </Button>
    </Tip>
  );
}, sameItem);

/** The zoom slider: minus and plus step 10 percent through views.zoomOut and views.zoomIn; the track's left half covers 10 to 100
 * and its right half 100 to 500, with a mark at 100. `off` greys it (Side to Side, where Word switches the zoom off). */
const ZoomSlider = memo(function ZoomSlider({ pct, off }) {
  return (
    <div data-feature="statusBar.zoomSlider" className="flex items-center gap-0.5">
      <Tip title="Zoom out" side="top">
        <Button variant="ghost" size="icon-xs" data-part="zoomOut" aria-label="Zoom out" disabled={off} onMouseDown={keep} onClick={() => run('views.zoomOut')}><Minus /></Button>
      </Tip>
      <div className="relative flex w-28 items-center">
        <span aria-hidden className="pointer-events-none absolute top-1/2 left-1/2 z-10 h-2.5 w-px -translate-y-1/2 bg-muted-foreground/60" />
        <Slider aria-label="Zoom" min={0} max={1000} step={1} value={[Math.round(pctToPos(pct) * 1000)]} disabled={off}
          onValueChange={([v]) => previewZoom(posToPct(v / 1000))} onValueCommit={() => { settleZoom(); refocusEditor(); }} />
      </div>
      <Tip title="Zoom in" side="top">
        <Button variant="ghost" size="icon-xs" data-part="zoomIn" aria-label="Zoom in" disabled={off} onMouseDown={keep} onClick={() => run('views.zoomIn')}><Plus /></Button>
      </Tip>
    </div>
  );
});

const VIEWS = [
  ['read', 'view.views.readMode', 'Read Mode', BookOpen],
  ['print', 'view.views.printLayout', 'Print Layout', FileText],
  ['web', 'view.views.webLayout', 'Web Layout', Globe],
];

/** Read Mode, Print Layout and Web Layout, the current view pressed. */
const ViewShortcuts = memo(function ViewShortcuts({ view }) {
  return (
    <div data-feature="statusBar.viewShortcuts" className="flex items-center">
      {VIEWS.map(([id, cmd, label, Icon]) => (
        <Tip key={id} title={label} side="top">
          <Button variant="ghost" size="icon-xs" data-view={id} aria-label={label} aria-pressed={view === id} onMouseDown={keep} onClick={() => run(cmd)}
            className={cn(view === id && 'bg-accent text-foreground')}>
            <Icon />
          </Button>
        </Tip>
      ))}
    </div>
  );
});

/** Left and Right move between the bar's controls (a roving toolbar; F6 reaches the bar through ribbon-chrome). */
function moveFocus(e) {
  if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.target.closest('[role="slider"]')) return;
  const all = [...e.currentTarget.querySelectorAll('button:not([disabled]), [role="slider"]')];
  const i = all.indexOf(e.target);
  if (i < 0) return;
  e.preventDefault();
  all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length]?.focus();
}

/** The bar: StatusBar.jsx passes its classes and its own items, `lead` before Word's and `tail` after them. */
export function WordStatusBar({ className, lead, tail }) {
  const ed = useEditor();
  const word = useStore((s) => s.settings?.word);
  const w = useMemo(() => wordSettings({ word }), [word]);
  const on = w.statusBar;
  const view = useStore((s) => s.word.view);
  const extend = useStore((s) => s.word.extend);
  const overtype = useStore((s) => !!s.word.overtype);
  const screen = useStore((s) => s.word.readScreen);
  const live = useLiveZoom();
  const zoomPct = useStore((s) => s.zoomPct);
  const shownPct = live ?? zoomPct; // a previewed zoom (panzoom.js) while the slider or the wheel moves it
  const sideways = useStore((s) => s.viewsMove?.kind === 'side'); // Side to Side shows the fitting zoom, switched off (views)
  const unit = useUnit();
  const caps = useCapsLock();
  const [menu, setMenu] = useState(null); // {kind: 'customize' | 'proofing' | 'tracking', at, n} while a menu is open
  useStore((s) => s.focusedSession); // re-renders when the focused canvas draft changes
  const session = activeSurface()?.session ?? null;
  const all = menu?.kind === 'customize'; // its checklist shows every item's value
  const shown = [
    (all || on.formattedPageNumber || on.pageNumber) && 'page', (all || on.pageNumber) && 'pages', (all || on.section) && 'section',
    (all || on.wordCount) && 'words', (all || on.characterCount) && 'chars',
  ].filter(Boolean).join(' ');
  const eng = useEngineCounts(session, w.proofing.countNotes ?? true, shown);
  const caret = useCaret(session ? null : ed, menu?.kind === 'customize' ? { verticalPosition: true, lineNumber: true, column: true } : on, zoomPct);

  useEffect(() => {
    let n = 0;
    customize.open = (at) => {
      setMenu({ kind: 'customize', at, n: ++n });
      return true;
    };
    return () => {
      customize.open = () => false;
    };
  }, []);

  // Focus shows the page alone (views), so only the app's items stay; Read Mode keeps the screen count, the view buttons and the zoom.
  if (view === 'focus' || view === 'immersive') return <footer className={className}>{lead}{tail}</footer>;
  const read = view === 'read';

  const state = session ? null : ed?.state ?? null;
  const display = w.tracking.display;
  const pg = state ? paginationKey.getState(state) : null;
  const page = eng?.page ?? pg?.page ?? 1;
  const pages = eng?.pages ?? pg?.pages ?? 1;
  const formatted = (state && geometryOf(state)?.pages?.[page - 1]?.label) ?? String(page);
  const head = state?.selection.head ?? 0;
  const section = eng?.section ?? (state ? sectionAt(sectionsOf(state.doc), head).index + 1 : 1);
  const total = eng ? eng.total : state ? docCounts(state.doc, display) : ZERO;
  const part = eng ? eng.part : state && !state.selection.empty
    ? state.selection.ranges.map((r) => rangeCounts(state.doc, r.$from.pos, r.$to.pos, display)).reduce((a, b) => ({
      words: a.words + b.words, chars: a.chars + b.chars, charsSp: a.charsSp + b.charsSp, paras: a.paras + b.paras }), ZERO)
    : null;
  const runLang = state && (state.storedMarks ?? state.selection.$head.marks()).find((m) => m.type.name === 'textStyle')?.attrs.lang;
  const lang = (typeof runLang === 'string' ? runLang : runLang?.val) || w.proofing.languages?.[0] || 'en-US';
  const tracking = session ? !!commandOf('review.tracking.trackChanges')?.active?.(ctxOf()) : !!state?.doc.attrs.settings?.trackRevisions;
  const flagged = valueOf('review.proofing.spellingAndGrammar');
  const issues = valueOf('review.accessibility.checkAccessibility');
  const verdict = issues == null ? null : issues ? 'Investigate' : 'Good to go';
  const ProofIcon = flagged == null ? Book : flagged ? BookX : BookCheck;
  const proofText = flagged == null ? '' : flagged ? 'Errors found' : 'No errors';
  const num = (n) => Number(n).toLocaleString('en-US');

  const openMenu = (kind) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ kind, at: { x: e.clientX, y: e.clientY }, n: Date.now() });
  };
  const close = () => setMenu(null);

  // Each item's current value at the right of Customize Status Bar.
  const values = {
    formattedPageNumber: formatted,
    section: String(section),
    pageNumber: `${page} of ${pages}`,
    verticalPosition: caret.vertical == null ? '' : positionText(caret.vertical, unit).slice(3),
    lineNumber: caret.line == null ? '' : String(caret.line),
    column: caret.column == null ? '' : String(caret.column),
    wordCount: num(total.words),
    characterCount: num(total.charsSp),
    proofing: proofText,
    language: languageName(lang),
    trackChanges: tracking ? 'On' : 'Off',
    capsLock: caps ? 'On' : 'Off',
    overtype: overtype ? 'Overtype' : 'Insert',
    selectionMode: MODE_TEXT[extend] ?? '',
    accessibility: verdict ?? '',
    focus: '',
    viewShortcuts: '',
    zoomSlider: '',
    zoom: `${zoomPct}%`,
  };

  const left = read ? [screen && <span key="screen" data-feature="statusBar.pageNumber" className="tabular-nums">{`Screen ${screen.n} of ${screen.m}`}</span>] : [
    PROMPT_TEXT[extend] && <span key="prompt" data-statusbar-prompt="" className="text-foreground">{PROMPT_TEXT[extend]}</span>,
    on.formattedPageNumber && <Item key="fpn" k="formattedPageNumber">{formatted}</Item>,
    on.section && <Item key="section" k="section">{`Section: ${section}`}</Item>,
    on.pageNumber && <Item key="page" k="pageNumber" tip="Open the navigation pane" onClick={() => run('view.show.navigationPane')}>{`Page ${page} of ${pages}`}</Item>,
    on.verticalPosition && caret.vertical != null && <Item key="at" k="verticalPosition">{positionText(caret.vertical, unit)}</Item>,
    on.lineNumber && caret.line != null && <Item key="line" k="lineNumber">{`Line ${caret.line}`}</Item>,
    on.column && caret.column != null && <Item key="col" k="column">{`Column ${caret.column}`}</Item>,
    on.wordCount && (
      <Item key="words" k="wordCount" tip="Open the word count" onClick={() => run('review.proofing.wordCount')}>
        {wordsText(total.words, part && part.words)}
      </Item>
    ),
    on.characterCount && <Item key="chars" k="characterCount">{charsText(total.charsSp, part && part.charsSp)}</Item>,
    on.proofing && (
      <Item key="proof" k="proofing" tip="Check spelling"
        onClick={() => run('review.proofing.spellingAndGrammar')} onContextMenu={openMenu('proofing')}>
        <ProofIcon data-state={flagged == null ? 'unknown' : flagged ? 'errors' : 'clean'} aria-label="Spelling and Grammar Check" />
      </Item>
    ),
    on.language && <Item key="lang" k="language" tip="Set the proofing language" onClick={() => run('review.language.language.setProofingLanguage')}>{languageName(lang)}</Item>,
    on.trackChanges && (
      <Item key="track" k="trackChanges" tip="Turn Track Changes on or off" onClick={() => run('review.tracking.trackChanges')} onContextMenu={openMenu('tracking')}>
        {`Track Changes: ${tracking ? 'On' : 'Off'}`}
      </Item>
    ),
    on.capsLock && caps && <Item key="caps" k="capsLock">Caps Lock</Item>,
    on.overtype && <Item key="ovr" k="overtype" tip="Switch between inserting and typing over text" onClick={() => run('editing.overtype')}>{overtype ? 'Overtype' : 'Insert'}</Item>,
    on.selectionMode && MODE_TEXT[extend] && <Item key="mode" k="selectionMode">{MODE_TEXT[extend]}</Item>,
    on.accessibility && (
      <Item key="a11y" k="accessibility" tip="Check accessibility" onClick={() => run('review.accessibility.checkAccessibility')}>
        <Accessibility />{verdict ? `Accessibility: ${verdict}` : 'Accessibility'}
      </Item>
    ),
  ];

  return (
    <footer data-statusbar="" role="toolbar" aria-label="Status bar" data-word-view={view} className={cn(className, 'select-none')}
      onContextMenu={openMenu('customize')} onKeyDown={moveFocus}>
      {lead}
      <div className="flex min-w-0 items-center gap-4 overflow-hidden">{left.filter(Boolean)}</div>
      {tail}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {!read && on.focus && (
          <Item k="focus" tip="Focus" onClick={() => run('view.immersive.focus')}><Focus />Focus</Item>
        )}
        {on.viewShortcuts && <ViewShortcuts view={view} />}
        {on.zoomSlider && <ZoomSlider pct={shownPct} off={sideways} />}
        {on.zoom && <Item k="zoom" tip="Zoom" onClick={sideways ? undefined : () => run('view.zoom.zoom')} className="w-12 justify-end">{`${shownPct}%`}</Item>}
      </div>
      {menu?.kind === 'customize' && (
        <PointMenu key={menu.n} at={menu.at} onClose={close} label="Customize Status Bar" feature="statusBar.customize">
          <DropdownMenuLabel className="text-xs">Customize Status Bar</DropdownMenuLabel>
          {ITEMS.map(({ key, label }) => (
            <DropdownMenuCheckboxItem key={key} data-feature={`statusBar.${key}`} checked={!!on[key]} className="text-xs"
              onSelect={(e) => {
                e.preventDefault(); // the checklist stays open, as Word's does
                toggleItem(key, getState().settings);
              }}>
              <span className="flex-1">{label}</span>
              <span className="ml-6 text-muted-foreground tabular-nums">{values[key]}</span>
            </DropdownMenuCheckboxItem>
          ))}
        </PointMenu>
      )}
      {menu?.kind === 'proofing' && (
        <PointMenu key={menu.n} at={menu.at} onClose={close} label="Spelling and Grammar Check">
          <DropdownMenuCheckboxItem className="text-xs" checked={!!w.proofing.hideSpelling}
            onSelect={() => saveWord({ proofing: { hideSpelling: !w.proofing.hideSpelling } })}>
            <Access label="Hide &Spelling Errors" />
          </DropdownMenuCheckboxItem>
          {/* No grammar checker yet: the item shows why it is off (a disabled item takes no pointer, so no tooltip). */}
          <DropdownMenuCheckboxItem className="flex-col items-start gap-0 text-xs" checked={false} disabled>
            <Access label="Hide &Grammatical Errors" />
            <span className="text-[0.7rem] text-muted-foreground">{REASONS.grammar}</span>
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-xs" onSelect={() => proofingOptions()}><Access label="&Options..." /></DropdownMenuItem>
        </PointMenu>
      )}
      {menu?.kind === 'tracking' && (
        <PointMenu key={menu.n} at={menu.at} onClose={close} label="Track Changes">
          <DropdownMenuCheckboxItem className="text-xs" checked={tracking} onSelect={() => run('review.tracking.trackChanges')}><Access label="&Track Changes" /></DropdownMenuCheckboxItem>
          <DropdownMenuItem className="text-xs" onSelect={() => run('review.markup.reviewingPane')}>Reviewing Pane</DropdownMenuItem>
          <DropdownMenuItem className="text-xs" onSelect={() => run('review.markup.launcher')}><Access label="&Options..." /></DropdownMenuItem>
        </PointMenu>
      )}
    </footer>
  );
}
