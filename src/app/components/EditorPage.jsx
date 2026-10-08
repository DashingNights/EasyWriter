import { cn } from 'cn';

// Pannable editor area with the page preview (a canvas-like view: wheel scrolls, Ctrl + wheel zooms around the pointer,
// middle-drag pans; actions.js). The TipTap editor mounts into #editor (actions.mountEditor) and applyZoom sets the CSS
// zoom of #page-wrap; React never touches either (it re-renders only the area's own attributes: behind a workspace, §7g,
// the area is hidden and inert but keeps its layout, so widths, zoom and export still measure it). The unzoomed pan
// surface around the page is one view minus PAGE_KEEP on every side, so the page can be moved anywhere but never further
// out than that.
// The horizontal scrollbar is hidden (panning replaces it); the vertical one stays for long posts.
export function EditorPage({ inert }) {
  return (
    <div id="editor-area" data-viewport inert={inert}
      className={cn('min-h-0 flex-1 overflow-auto bg-(--pg-bg) [container-type:size] [scrollbar-gutter:stable]', inert && 'invisible pointer-events-none')}>
      <div className="w-max p-[calc(100cqh-var(--page-keep))_calc(100cqw-var(--page-keep))] [--page-keep:120px]">
        <div id="page-wrap">
          <div className="page">
            <div id="editor" />
          </div>
        </div>
      </div>
    </div>
  );
}
