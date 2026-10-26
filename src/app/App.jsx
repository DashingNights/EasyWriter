import { useEffect, useRef, useSyncExternalStore } from 'react';
import { cn } from 'cn';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Assistant } from './assistant/Chat.jsx';
import { AgentAsk } from './components/AgentAsk.jsx';
import { BrowserPage, TabStrip, WebLayer } from './components/BrowserPage.jsx';
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
import { Onboarding } from './components/Onboarding.jsx';
import { PlanPage } from './components/plan/PlanPage.jsx';
import { QuickTools } from './components/QuickTools.jsx';
import { Sidebar, SidebarToggle } from './components/Sidebar.jsx';
import { StatusBar } from './components/StatusBar.jsx';
import { Toolbar } from './components/Toolbar.jsx';
import { ToolSearch } from './components/ToolSearch.jsx';
import { Dictation } from './dictation/Dictation.jsx';
import { NavPane } from '../document/NavPane.jsx';
import { SuggestionCards } from '../suggest/Review.jsx';
import { DocIsland } from '../document/Ribbon.jsx';
import { can } from './gates.mjs';
import { useStore, WORKER } from './store.js';
import { keybindsVersion, subscribeKeybinds } from './keybinds.js';
import { useViewportBox } from './viewport.js';

/** A workspace page in place of the editor (§7g), over the editor page, which stays mounted behind it. A page, not an
 * overlay: the sidebar navigates away from it and Escape at page level does nothing. */
function Workspace({ ui }) {
  return (
    <div id="workspace-root" tabIndex={-1} className="absolute inset-0 z-10 bg-background outline-none animate-page-in">
      {can('view.plan', ui) ? <PlanPage /> : <FlowsPage />}
    </div>
  );
}

/** The rail serves the editor and, in the flowchart library, only a board (the library editor's): it never formats the
 * document hidden behind a workspace. In a Document the tools island takes its place until a canvas is being edited
 * (docs/plans/document.md step 10). */
function Rail({ ui }) {
  const board = useBoard();
  const flows = can('view.flows', ui) && !!board;
  const isDocument = useStore((s) => s.draft?.format === 'document');
  const nav = useStore((s) => !!s.navPane) && isDocument && !flows; // the Document's navigation pane is at the column's left edge
  const box = useViewportBox(flows || nav);
  if (!(can('view.editor', ui) || flows)) return null;
  const rail = isDocument && !board
    ? <DocIsland className={cn(nav && 'pointer-events-auto')} />
    : <BoardRail className={cn('max-h-[calc(100%-8rem)]', (flows || nav) && 'pointer-events-auto')} />;
  // In the library editor (and beside a Document's navigation pane) the rail's (or island's) positioned ancestor is the whole
  // column: a box over the board's view ([data-viewport], right of the shape panel, following its width and collapse) puts the rail at the
  // view's left edge and centres it there.
  return flows || nav ? <div className="pointer-events-none absolute" style={box ?? undefined}>{rail}</div> : rail;
}

/** The browser's tabs over the editor page (§7j): a strip at the top-left of the page's viewport (with no tabs, only its +
 * button). The plan and flowchart pages have their own headers there, so the strip stays off them. */
function BrowserTabs({ ui }) {
  const editor = useStore((s) => s.view.type === 'editor');
  const on = editor && !can('view.browser', ui);
  const box = useViewportBox(on);
  if (!on || !box) return null;
  return (
    <div data-browser-tabs className="absolute z-[25] flex min-h-9 items-center rounded-br-md border-r border-b bg-island p-1 text-xs text-card-foreground"
      style={{ left: box.left, top: box.top, maxWidth: box.width }}>
      <TabStrip />
    </div>
  );
}

/** A CSS colour as #rrggbb (Electron's title bar overlay takes no oklch()). */
function hex(css) {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  return `#${[...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** The title strip (§7, app.css .titlebar): the window's drag region with the app icon and name. The native window controls
 * are drawn over its right end in its background and text colours, sent to main at start and on every theme change. */
function TitleBar() {
  const dark = useStore((s) => s.uiDark);
  const palette = useStore((s) => s.settings?.palette);
  const ref = useRef(null);
  useEffect(() => {
    if (WORKER) return; // the background window (§7i) has no window controls of its own
    const cs = getComputedStyle(ref.current);
    window.api.window.titleBar({ color: hex(cs.backgroundColor), symbolColor: hex(cs.color) });
  }, [dark, palette]);
  return (
    <div ref={ref} data-titlebar className="titlebar col-span-2 flex items-center gap-[8px] border-b bg-card pl-[10px] text-card-foreground select-none">
      <img src="build/icon.svg" alt="" draggable={false} className="size-[16px]" />
      <span className="text-sm text-muted-foreground">EasyWriter</span>
    </div>
  );
}

// Grid: the title strip along the top; sidebar 290 px (0 and not rendered while collapsed) | main (scrollable editor area;
// floating over it, the board rail at its left edge, the sidebar button at its bottom-left corner and the toolbar as an
// island at its bottom centre, next to where new lines are usually typed); status bar along the bottom. The item ribbon and
// the canvas bars are fixed-positioned at the selected board item / canvas (a canvas is edited in place, in the page). Toasts
// are at the top right, 24 px below the 34 px title strip (clear of the window controls and the toolbar island); the notices
// (§7c) rest on the transcript pane (§7h) in one bottom-anchored column over the toolbar island, centred in the page's viewport (§7g).
// The quick tools island (Ctrl+Tab) is fixed-positioned at the pointer; the tour card is beside its step's target, or at the top
// centre of the page's viewport when the step has none on screen. A workspace page (§7g) replaces the editor area, its
// toolbar and its sidebar button; the sidebar navigates: its footer tabs show a workspace, its draft rows the editor.
export function App() {
  const collapsed = useStore((s) => !!s.settings?.sidebarCollapsed);
  useSyncExternalStore(subscribeKeybinds, keybindsVersion); // shortcut labels everywhere follow a rebind (§7k)
  const ui = { view: useStore((s) => s.view) };
  const editor = can('view.editor', ui);
  const browser = can('view.browser', ui);
  const dark = useStore((s) => s.uiDark);
  // A Document has its tools island at the editor area's left edge (Rail) in place of the bottom toolbar (docs/plans/document.md step 10).
  const isDocument = useStore((s) => s.draft?.format === 'document');
  const navPane = useStore((s) => !!s.navPane); // View > Navigation pane, beside the editor area
  return (
    <TooltipProvider delayDuration={300}>
      <div className={cn('grid h-screen grid-rows-[auto_1fr_auto]', collapsed ? 'grid-cols-[0_1fr]' : 'grid-cols-[290px_1fr]')}>
        <TitleBar />
        {!collapsed && <Sidebar />}
        <main className="col-start-2 flex min-h-0 min-w-0 flex-col">
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1">
              {editor && isDocument && navPane && <NavPane />}
              <EditorPage inert={!editor} />
            </div>
            {/* agent edits waiting as suggestions: their cards beside the sheet, in the page's space, under everything below
                (docs/plans/suggestions.md Display) */}
            <SuggestionCards />
            {/* §7i Background drafts: the hidden editors of the assistant's background sessions mount here (assistant/sessions.js) */}
            <div id="sessions" aria-hidden inert />
            {/* §7j: the browser page stays mounted too, so its tabs keep running behind the other pages */}
            <BrowserPage shown={browser} />
            {/* §7j: every tab's page, as the browser page's body or the floating pane over another page */}
            <WebLayer />
            {!editor && !browser && <Workspace ui={ui} />}
            <Rail ui={ui} />
            <BrowserTabs ui={ui} />
            {editor && <FindBar />}
            {editor && !isDocument && <Toolbar />}
            {editor && <SidebarToggle />}
            {/* §7h: the bottom column over the toolbar: the transcript pane with the §7c notice stack resting on it */}
            <Dictation><Notices /></Dictation>
            {/* §7i: the right island at the bottom-right (the dictation mic and chat buttons) and the panel over the page */}
            <Assistant />
            {/* the tour card and its ring, above the islands (Onboarding.jsx) */}
            <Onboarding />
          </div>
        </main>
        <StatusBar />
      </div>
      <ItemRibbon />
      <CanvasBar />
      <CanvasEditBar />
      <PlanChartBar />
      <HoverHint />
      <QuickTools />
      <BoardMenu />
      <DraftMenu />
      <DialogHost />
      <ToolSearch />
      <AgentAsk />
      <Toaster theme={dark ? 'dark' : 'light'} position="top-right" offset={{ top: 58 }} duration={5000} />
    </TooltipProvider>
  );
}
