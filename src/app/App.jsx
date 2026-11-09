import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cn } from 'cn';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Assistant } from './assistant/Chat.jsx';
import { BoardSlot } from '../board/BoardSlot.jsx';
import { AgentAsk } from './components/AgentAsk.jsx';
import { BrowserIsland, BrowserPage, TabStrip, WebLayer } from './components/BrowserPage.jsx';
import { BoardMenu } from './components/board/BoardMenu.jsx';
import { BoardRail } from './components/board/BoardRail.jsx';
import { CanvasBar, CanvasEditBar } from './components/board/CanvasBar.jsx';
import { useBoard } from './components/board/controls.jsx';
import { ItemRibbon } from './components/board/ItemRibbon.jsx';
import { PlanChartBar } from './components/board/PlanChartBar.jsx';
import { DialogHost } from './components/Dialogs.jsx';
import { DraftMenu } from './components/DraftMenu.jsx';
import { EditorPage } from './components/EditorPage.jsx';
import { FindBar } from './components/FindBar.jsx';
import { FlowsPage } from './components/flows/FlowsPage.jsx';
import { HoverHint } from './components/HoverHint.jsx';
import { Notices } from './components/Notices.jsx';
import { OpenProgress } from './components/OpenProgress.jsx';
import { PlanPage } from './components/plan/PlanPage.jsx';
import { QuickTools } from './components/QuickTools.jsx';
import { CitePicker } from './components/References.jsx';
import { Sidebar, SidebarButton, useNarrow } from './components/Sidebar.jsx';
import { StatusBar } from './components/StatusBar.jsx';
import { Toolbar } from './components/Toolbar.jsx';
import { ToolSearch } from './components/ToolSearch.jsx';
import { Tutorial } from './components/Tutorial.jsx';
import { Dictation } from './dictation/Dictation.jsx';
import { Setup } from './setup/Setup.jsx';
import { SuggestionCards } from '../suggest/Review.jsx';
import { Backstage, openBackstage } from '../document/ribbon/Backstage.jsx';
import { iconOf as wordIcon } from '../document/ribbon/icons.jsx';
import * as WORD_SPEC from '../document/ribbon/spec.mjs';
import { FontBox, SizeBox } from '../document/Ribbon.jsx';
import { MODULES } from '../document/wp/index.js';
import { wordSettings } from '../document/word/settings.mjs';
import { MarginCards } from '../tooling/cards.jsx';
import { PaneHost } from '../tooling/panes.jsx';
import { Ribbon } from '../tooling/ribbon/Ribbon.jsx';
import { can } from './gates.mjs';
import { areaOpens } from '../tooling/surface.js';
import { motion } from './motion.js';
import { afterSlide, slide } from './sliding.js';
import { setState, useStore, WORKER } from './store.js';
import { keybindsVersion, subscribeKeybinds } from './keybinds.js';
import { useViewportBox, viewportRect } from './viewport.js';
import { closeWorkspace } from './views.js';
import { Tip } from './components/Tip.jsx';
import { keepFocus } from './components/Toolbar.jsx';
import { installWordDrop } from '../document/docx/files.js';

/** A workspace page in place of the editor (§7g), over the editor page, which stays mounted behind it. A page, not an
 * overlay: the sidebar navigates away from it and Escape at page level does nothing. */
function Workspace({ ui }) {
  return (
    <div id="workspace-root" tabIndex={-1} className="absolute inset-0 z-10 bg-background outline-none animate-page-in">
      {can('view.plan', ui) ? <PlanPage /> : <FlowsPage />}
    </div>
  );
}

/** For the page holding `board` (a Document's canvas being edited), from the area's left (main > div): {page: the page's left
 * edge, inset: the working viewport's (right of the vertical ruler)}, or null. It follows the area's and the page's size (zoom),
 * a sideways scroll, a zoom preview, the ruler, the side panes' push (PageHold, measured a frame later) and the sidebar's slide. */
function usePageLeft(board) {
  const [left, setLeft] = useState(null);
  useLayoutEffect(() => {
    if (!board) return setLeft(null);
    const area = document.querySelector('main > div');
    const scroller = document.getElementById('editor-area');
    const pageOf = () => board.dom?.closest?.('.page') ?? scroller?.querySelector('.page');
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (afterSlide(measure)) return;
        const page = pageOf();
        const at = area.getBoundingClientRect().left;
        setLeft(page ? { page: page.getBoundingClientRect().left - at, inset: Math.max(0, viewportRect().left - at) } : null);
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of [area, scroller, pageOf()]) if (el) ro.observe(el);
    scroller?.addEventListener('scroll', measure, { passive: true });
    addEventListener('zoompreview', measure);
    addEventListener('viewportinset', measure);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      scroller?.removeEventListener('scroll', measure);
      removeEventListener('zoompreview', measure);
      removeEventListener('viewportinset', measure);
    };
  }, [board]);
  return left;
}

// Beside the page, the Layers panel opens left of the rail when the page is this far from the working viewport's edge (the
// panel's 15rem from 3.5rem out, BoardRail and LayersPanel), else right of it, over the page; the rail's own box (0.5rem each
// side of it) is the least room it takes, so a page with less room leaves the rail at the viewport's edge, right of the ruler.
const LAYERS_ROOM = 260;
const RAIL_ROOM = 48;

/** Whether a change of `place` (not its first value) is still animating: true for the Islands motion from the render that
 * changes it, so the transition is on as the new width lands; a timer ends it, as the rail then follows the page at once. */
function useGlide(place) {
  const last = useRef(place);
  const until = useRef(0);
  const [, tick] = useState(0);
  if (last.current != null && place != null && place !== last.current) until.current = performance.now() + motion('islands');
  last.current = place;
  const on = performance.now() < until.current;
  useEffect(() => {
    if (!on) return undefined;
    const t = setTimeout(() => tick((n) => n + 1), until.current - performance.now() + 20);
    return () => clearTimeout(t);
  });
  return on;
}

/** The rail serves the editor and, in the flowchart library, only a board (the library editor's): it never formats the
 * document hidden behind a workspace. A Document has the ribbon instead, and the rail shows only while one of its canvases
 * is being edited (the ribbon stays mounted then). */
function Rail({ ui }) {
  const board = useBoard();
  const flows = can('view.flows', ui) && !!board;
  const isDocument = useStore((s) => s.draft?.format === 'document');
  const boardHud = useStore((s) => s.boardHud); // a document focused on a board has the ribbon instead (bd-hud)
  const pane = useStore((s) => !!s.panes.left) && isDocument && !flows; // a Document's left pane is at the column's left edge
  const box = useViewportBox(flows || pane);
  // While a Document's canvas is edited the rail docks beside the page's left edge, the Layers panel left of it when it fits
  // (the user, 2026-10-28: the tools next to what they work on).
  const dock = usePageLeft(isDocument && board && !flows && !pane ? board : null);
  // Zoomed in, the page passes the viewport's edge and the rail goes to its place there (the forum post's left island, right of
  // the ruler), gliding from beside the page and back rather than jumping (the user, 2026-10-29).
  const beside = !!dock && dock.page >= dock.inset + RAIL_ROOM;
  const glide = useGlide(dock ? beside : null);
  if (!(can('view.editor', ui) || flows) || (isDocument && !board) || boardHud === 'document') return null;
  if (dock) {
    return (
      <div data-rail-dock={beside ? 'page' : 'edge'} className="pointer-events-none absolute inset-y-0 left-0"
        style={{ width: beside ? dock.page : dock.inset + RAIL_ROOM, transition: glide ? `width ${motion('islands')}ms ease-out` : undefined }}>
        <BoardRail end layers={dock.page - dock.inset >= LAYERS_ROOM ? 'before' : 'after'} className="max-h-[calc(100%-8rem)] pointer-events-auto" />
      </div>
    );
  }
  const rail = <BoardRail className={cn('max-h-[calc(100%-8rem)]', (flows || pane) && 'pointer-events-auto')} />;
  // In the library editor (and beside a Document's left pane) the rail's positioned ancestor is the whole column: a box over
  // the board's view ([data-viewport], right of the shape panel, following its width and collapse) puts the rail at the
  // view's left edge and centres it there.
  return flows || pane ? <div className="pointer-events-none absolute" style={box ?? undefined}>{rail}</div> : rail;
}

// ---------------------------------------------------------------------------------------------
// Word parity (docs/plans/word/plan.md §1.7, §1.12, §2.8): the ribbon, the backstage, the panes and the modules' slots, all for
// an open Document in the editor view only and all inside the page area (direction.md 6): the title strip stays the app's.

// The spec with the tab rules plan.md §1.4 Contexts gives that the generated CONTEXTS do not carry yet: Header & Footer comes
// forward when editing starts and Reader hides the main tabs. ponytail: these belong in scripts/word-spec-data.mjs; here until
// the generator writes them.
const SPEC = {
  ...WORD_SPEC,
  CONTEXTS: { ...WORD_SPEC.CONTEXTS, header: { ...WORD_SPEC.CONTEXTS.header, activate: true }, immersive: { ...WORD_SPEC.CONTEXTS.immersive, alone: true } },
};

// The Font and Font Size boxes the ribbon falls back to while no package provides their lists (the island's own boxes).
const BOXES = {
  'home.font.font': ({ ctx }) => <FontBox T={ctx.T} />,
  'home.font.fontSize': ({ ctx }) => <SizeBox T={ctx.T} />,
};
const slotsOf = (key) => MODULES.map((m) => m.slots?.[key] && [m.id, m.slots[key]]).filter(Boolean);
const BELOW = slotsOf('belowRibbon');
const OVER = slotsOf('viewport');
const WORD_STATUS = slotsOf('statusBar')[0]?.[1]; // Word's status bar items, which the app's own bar shows while the Word chrome is on
const MARK_KINDS = ['tabs', 'spaces', 'paragraphs', 'hidden', 'optionalHyphens', 'anchors'];
const CUSTOMIZE_QAT = 'frame.qat.customize'; // the Quick Access Toolbar's own menu, after the commands it shows
const NO_QAT = [];

/** Whether the Word chrome shows: an open Document in the editor view, or a board whose HUD is a document's (bd-hud). */
function useWordChrome() {
  const editor = useStore((s) => s.view.type === 'editor');
  const isDocument = useStore((s) => s.draft?.format === 'document');
  const boardHud = useStore((s) => s.boardHud);
  return editor && (isDocument || boardHud === 'document');
}

/** The ribbon at the top of the editor column, then the belowRibbon slots (also while the ribbon is hidden). Hidden in Read
 * Mode; in Focus and full-screen mode it is drawn over the page only while the pointer is within 8 px of the column's top. */
function WordRibbon({ titleBar }) {
  // A document on a board is always print layout: Read Mode and the other views are a Document's own (bd-hud).
  const view = useStore((s) => (s.boardHud === 'document' ? 'print' : s.word.view));
  const full = useStore((s) => wordSettings(s.settings).ribbon.display === 'fullscreen');
  const developer = useStore((s) => !!wordSettings(s.settings).ribbon.developer);
  const opts = useStore((s) => wordSettings(s.settings).ribbon);
  const quick = opts.qatHidden ? NO_QAT : [...opts.qat, CUSTOMIZE_QAT];
  return (
    <header data-word-chrome="" className="relative z-20 shrink-0">
      {view !== 'read' && (
        <Ribbon spec={SPEC} icons={wordIcon} boxes={BOXES} show={developer ? ['developer'] : []} autoHide={full || view === 'focus'}
          qat={quick} onFile={() => openBackstage()} titleBar={titleBar} lead={titleBar && <SidebarButton side="bottom" />} />
      )}
      {BELOW.map(([id, Slot]) => <Slot key={id} />)}
    </header>
  );
}

/** Keeps the page where it was when a side pane opens (the user, 2026-10-28: a pane pushed the document): while it fits, the
 * page stays centred on the column as if no pane were open, and only the part of the offset the page has no room for pushes it.
 * Sets --shift-l and --shift-r on #editor-area, the padding app.css adds on each side of the Word view's pages. */
function PageHold({ on }) {
  const panes = useStore((s) => s.panes);
  const zoom = useStore((s) => s.zoomPct);
  useEffect(() => {
    const area = document.getElementById('editor-area');
    const wrap = document.getElementById('page-wrap');
    if (!area || !wrap) return undefined;
    const side = (s) => document.querySelector(`[data-pane-side="${s}"]`)?.offsetWidth ?? 0;
    const hold = () => {
      if (afterSlide(hold)) return; // the sidebar's slide: once it ends (sliding.js)
      const want = on ? (side('right') - side('left')) / 2 : 0;
      const room = Math.max(0, (area.clientWidth - 48 - wrap.getBoundingClientRect().width) / 2);
      const s = Math.max(-room, Math.min(room, want));
      area.style.setProperty('--shift-l', `${Math.max(0, 2 * s)}px`);
      area.style.setProperty('--shift-r', `${Math.max(0, -2 * s)}px`);
    };
    hold();
    const ro = new ResizeObserver(hold);
    ro.observe(area);
    ro.observe(wrap);
    return () => {
      ro.disconnect();
      area.style.removeProperty('--shift-l');
      area.style.removeProperty('--shift-r');
    };
  }, [on, panes, zoom]);
  return null;
}

/** The modules' viewport slots, absolutely over the editor area's viewport box (the vertical ruler). */
function ViewportSlots() {
  const box = useViewportBox(OVER.length > 0, true);
  if (!OVER.length || !box) return null;
  return <div data-viewport-slots="" className="pointer-events-none absolute z-[15]" style={box}>{OVER.map(([id, Slot]) => <Slot key={id} />)}</div>;
}

/** Puts data-word-view, data-marks and data-field-codes on #editor-area from the store (plan.md §1.12), which WP CSS keys on;
 * none while `on` is false (no Document in the editor view). data-marks lists the kinds shown, every one plus 'all' while
 * marks.all is on; data-field-codes is 'on' while field codes show. */
function WordMarkers({ on }) {
  const view = useStore((s) => (s.boardHud === 'document' ? 'print' : s.word.view));
  const marks = useStore((s) => {
    const m = wordSettings(s.settings).marks;
    return m.all ? [...MARK_KINDS, 'all'].join(' ') : MARK_KINDS.filter((k) => m[k]).join(' ');
  });
  const codes = useStore((s) => !!wordSettings(s.settings).fieldCodes);
  useEffect(() => {
    const area = document.getElementById('editor-area');
    if (!area) return undefined;
    const set = (k, v) => (v ? area.setAttribute(k, v) : area.removeAttribute(k));
    set('data-word-view', on && view);
    set('data-marks', on && marks);
    set('data-field-codes', on && codes && 'on');
    return () => ['data-word-view', 'data-marks', 'data-field-codes'].forEach((k) => area.removeAttribute(k));
  }, [on, view, marks, codes]);
  return null;
}

/** The toasts at the viewport's top right, under the ribbon or a page's header instead of over their buttons (the user,
 * 2026-10-28), left of the scrollbar; they follow the viewport. */
function Toasts({ dark }) {
  const box = useViewportBox(true);
  const area = box && document.querySelector('main > div').getBoundingClientRect();
  const offset = box ? { top: area.top + box.top + 8, right: innerWidth - area.right + box.right + box.scrollbar + 8 } : { top: 58 };
  return <Toaster theme={dark ? 'dark' : 'light'} position="top-right" offset={offset} duration={5000} />;
}

/** A CSS colour as #rrggbb (Electron's title bar overlay takes no oklch()). */
function hex(css) {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  return `#${[...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** The title strip (§7, app.css .titlebar) over the main column while the ribbon's tab row is not the title row: the window's
 * drag region with the sidebar button at its left end, and on a workspace page Back to editor beside it, in words (the user,
 * 2026-10-28: the buttons that move between pages sit at the left, where the editor has its own), then the browser page's tabs.
 * A header, not a div: useViewportBox measures against main's first div. */
function TitleBar() {
  const view = useStore((s) => s.view.type);
  return (
    <header data-titlebar className="titlebar flex shrink-0 items-center gap-[8px] text-xs select-none">
      {/* As the ribbon's tab row: what follows starts at 45 px, beside the minimized sidebar's rail */}
      <span className="flex w-[26.75px] shrink-0"><SidebarButton side="bottom" /></span>
      {view !== 'editor' && (
        <Tip title="Back to the open draft" side="bottom">
          <Button variant="outline" size="xs" data-back-to-editor onMouseDown={keepFocus} onClick={() => closeWorkspace()}>Back to editor</Button>
        </Tip>
      )}
      {view === 'browser' && <TabStrip />}
    </header>
  );
}

/** Sends the colours of the title row on screen ([data-titlebar]: TitleBar or the ribbon's tab row) to main, which draws the
 * native window controls over its right end in them: at start, on a theme change and when the other row takes over. */
function useWindowControls(deps) {
  useEffect(() => {
    if (WORKER) return; // the background window (§7i) has no window controls of its own
    const el = document.querySelector('[data-titlebar]');
    if (!el) return;
    const cs = getComputedStyle(el);
    window.api.window.titleBar({ color: hex(cs.backgroundColor), symbolColor: hex(cs.color) });
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}

// Grid: sidebar 290 px, the window's full height (0 and not rendered while collapsed) | main (the title row at its top: the
// ribbon's tab row while a Document shows its ribbon, else the title strip, either with the sidebar button at its left end;
// under it the scrollable editor area, floating over it the board rail at its left edge and the toolbar as an island at its
// bottom centre, next to where new lines are usually typed); status bar along the bottom. The item ribbon and
// the canvas bars are fixed-positioned at the selected board item / canvas (a canvas is edited in place, in the page). Toasts
// are at the viewport's top right (Toasts), clear of the title row and the ribbon; the notices
// (§7c) rest on the transcript pane (§7h) in one bottom-anchored column over the toolbar island, centred in the page's viewport (§7g).
// The quick tools island (Ctrl+Tab) is fixed-positioned at the pointer; the tutorial dims everything under the title strip, its
// card beside the light. A workspace page (§7g) replaces the editor area, its toolbar and its sidebar button; the sidebar
// navigates: its footer tabs show a workspace, its draft rows the editor.
export function App() {
  // Minimized (the user's choice, or a window too narrow for it) the sidebar is a rail of icons (Sidebar mini, whose pod's menu
  // holds the projects and drafts); in a narrow window the sidebar button shows the whole sidebar over the column (peek), which
  // closes on a press outside it and once a draft or page opens, so the sidebar stays minimized.
  const narrow = useNarrow();
  const collapsed = useStore((s) => !!s.settings?.sidebarCollapsed) || narrow;
  const peekOn = useStore((s) => s.sidebarPeek) && collapsed;
  const [peek, setPeek] = useState(peekOn); // shown: it stays while it slides away
  useEffect(() => {
    if (peekOn) return setPeek(true);
    const t = setTimeout(() => setPeek(false), motion('sidebar'));
    return () => clearTimeout(t);
  }, [peekOn]);
  // The sidebar slides (motion 'sidebar') between its width and the rail's: its column's width and the title row's margin
  // transition (app.css), and the whole sidebar stays drawn while it slides shut, clipped by its column, before the rail.
  const [full, setFull] = useState(!collapsed);
  useEffect(() => slide(motion('sidebar')), [collapsed]);
  useEffect(() => {
    if (!collapsed) return setFull(true);
    const t = setTimeout(() => setFull(false), motion('sidebar'));
    return () => clearTimeout(t);
  }, [collapsed]);
  const opened = useStore((s) => `${s.draft?.id}|${s.view.type}`);
  useEffect(() => setState({ sidebarPeek: false }), [narrow, opened]);
  useEffect(() => installWordDrop(), []); // a Word file dropped anywhere opens as a new Document
  useSyncExternalStore(subscribeKeybinds, keybindsVersion); // shortcut labels everywhere follow a rebind (§7k)
  const ui = { view: useStore((s) => s.view) };
  const editor = can('view.editor', ui);
  const browser = can('view.browser', ui);
  const dark = useStore((s) => s.uiDark);
  // A Document has the ribbon over the editor area in place of the bottom toolbar (docs/plans/word/plan.md §2.8); a whiteboard
  // has neither, its board filling the area with its own tools.
  const isDocument = useStore((s) => s.draft?.format === 'document');
  const isBoard = useStore((s) => s.draft?.format === 'board');
  const boardHud = useStore((s) => s.boardHud);
  // The modules' viewport slots: a Document's always, and a forum post's only while the canvas page area opens it (surface.js
  // areaOpens: post.js), so a post in the DOM editor gets none of Word's chrome.
  const slots = useStore((s) => s.view.type === 'editor' && (s.draft?.format === 'document' || areaOpens(s)));
  const word = useWordChrome();
  // The ribbon's tab row is the title row while the ribbon shows in place. In full-screen mode (settings.word.ribbon.display),
  // Focus and Read Mode the title strip takes its place: without it the window controls would draw over the page and the window
  // would have no drag region.
  const wordView = useStore((s) => (s.boardHud === 'document' ? 'print' : s.word.view));
  const fullRibbon = useStore((s) => wordSettings(s.settings).ribbon.display === 'fullscreen');
  const ribbonTitle = word && !fullRibbon && wordView !== 'read' && wordView !== 'focus';
  const palette = useStore((s) => s.settings?.palette);
  useWindowControls([dark, palette, ribbonTitle]);
  return (
    <TooltipProvider delayDuration={300}>
      <div data-app-grid="" className={cn('grid h-screen grid-rows-[1fr_auto]', collapsed ? 'grid-cols-[40px_1fr]' : 'grid-cols-[290px_1fr]')}>
        <div className="grid min-h-0 min-w-0 overflow-hidden">
          {/* One sidebar open and minimized, so its workspace and Settings buttons stay the same elements (Sidebar.jsx) */}
          <div className={cn('grid min-h-0 will-change-transform', full ? 'w-[290px]' : 'w-[40px]')}><Sidebar mini={!full} shut={collapsed} /></div>
        </div>
        {peek && (
          <>
            {peekOn && <div aria-hidden className="fixed inset-0 z-40" onPointerDown={() => setState({ sidebarPeek: false })} />}
            <div data-sidebar-peek={peekOn ? '' : 'closing'} inert={!peekOn || undefined}
              className={cn('fixed top-[34px] bottom-0 left-0 z-40 grid w-[290px] rounded-tr-lg border-t bg-background shadow-2xl duration-(--motion-sidebar) ease-out fill-mode-forwards',
                peekOn ? 'animate-in slide-in-from-left' : 'animate-out slide-out-to-left')}><Sidebar strip={false} /></div>
          </>
        )}
        {/* --side-w: the title row reaches left over the sidebar's empty top strip to the window's edge (app.css .titlebar), so the
            sidebar button and the tabs start there whether the sidebar shows or not */}
        <main className="col-start-2 flex min-h-0 min-w-0 flex-col" style={{ '--side-w': collapsed ? '40px' : '290px' }}>
          {!ribbonTitle && <TitleBar />}
          {word && <WordRibbon titleBar={ribbonTitle} />}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1">
              {word && <PaneHost side="left" />}
              <EditorPage inert={!editor} />
              {word && <PaneHost side="right" />}
            </div>
            {word && <PaneHost side="bottom" />}
            {/* agent edits waiting as suggestions: their cards beside the sheet, in the page's space, under everything below
                (docs/wiki/suggestions.md Display); the Word packages' margin cards (comments, balloons) beside them */}
            <SuggestionCards />
            <MarginCards />
            <WordMarkers on={word} />
            <PageHold on={word} />
            {slots && <ViewportSlots />}
            {editor && <BoardSlot />}
            {/* §7i Background drafts: the hidden editors of the assistant's background sessions mount here (assistant/sessions.js) */}
            <div id="sessions" aria-hidden inert />
            {/* §7j: the browser page stays mounted too, so its tabs keep running behind the other pages */}
            <BrowserPage shown={browser} />
            {/* §7j: every tab's page, as the browser page's body or the floating pane over another page */}
            <WebLayer />
            {!editor && !browser && <Workspace ui={ui} />}
            <Rail ui={ui} />
            <BrowserIsland ui={ui} />
            {editor && <FindBar />}
            {/* a document opening, or why it could not (open-worker), over the viewport */}
            <OpenProgress />
            {editor && !isDocument && (!isBoard || boardHud === 'forum-post' || boardHud === 'page') && <Toolbar />}
            {/* §7h: the bottom column over the toolbar: the transcript pane with the §7c notice stack resting on it */}
            <Dictation><Notices /></Dictation>
            {/* §7i: the right island at the bottom-right (the dictation mic and chat buttons) and the panel over the page */}
            <Assistant />
          </div>
        </main>
        <StatusBar Word={word ? WORD_STATUS : null} />
      </div>
      <ItemRibbon />
      <CanvasBar />
      <CanvasEditBar />
      <PlanChartBar />
      <HoverHint />
      <QuickTools />
      <CitePicker />
      <BoardMenu />
      <DraftMenu />
      <DialogHost />
      {/* the setup on the first start and after Run setup again (setup/Setup.jsx) */}
      <Setup />
      {/* the tutorial's dim, light, card and pointer, over the dialogs (Tutorial.jsx) */}
      <Tutorial />
      {word && <Backstage spec={SPEC} />}
      <ToolSearch />
      <AgentAsk />
      <Toasts dark={dark} />
    </TooltipProvider>
  );
}
