# DAF Writer — UI libraries across the plans

Planning only. This answers the user's question of 2026-10-06, "any UI libraries we can use?", for the three plans: `docs/plans/flowchart.md` §8, `docs/plans/gantt-kanban.md` §9 and `docs/plans/agent-automation.md` §8. The facts come from a library survey on 2026-10-06, checked by a second pass. The survey used the npm registry, bundlephobia / bundlejs sizes, repository activity and vendor docs, and searched the shipped bundles for `eval`, `new Function`, WebAssembly and Worker. Nothing was installed. Anything the survey did not check is marked *unverified*. Sizes are minified / gzip unless noted.

## 1. Answer

Yes, where a library clearly saves work and fits the constraints in §2. More than 70 candidates were checked, and one clears that bar: **`@dagrejs/dagre`**, for flowchart auto-layout (flowchart Phase 4). Everything else the plans need is either already installed or own code of a few dozen to ~150 lines that no library would remove. The installed packages are the shadcn components on `radix-ui`, `lucide-react`, `cmdk`, `sonner` and `html-to-image`.

- **Flowchart rotation and labels.** Free rotation and the three connector labels fit inside the Board's existing selection, snap and commit pipeline. The libraries checked each fail for one of three reasons:
  - they have no rotation (interact.js, react-rnd);
  - they have had no release since Dec 2023 and bring a second selection system (moveable);
  - they draw on `<canvas>` and break the DOM export (Konva, fabric).
  No surveyed library offers more than one label per edge.
- **Gantt.** Every free Gantt library puts the must-haves behind a PRO licence: FS/SS/FF/SF dependencies with lag, critical path, baseline and a working-day calendar.
- **Drag and drop.** A drag library would replace only the Kanban / Backlog half of a ~150-line pointer helper. The Gantt gestures need the same pointer code anyway.

New UI component: the shadcn `textarea`, added once by the CLI and shared by the Gantt ticket dialog and the flowchart import dialog. New runtime dependencies across all three plans: `@dagrejs/dagre` (verified) and `@tiptap/markdown` for the agent layer (not UI, *unverified*, §6); the later local assistant (agent plan §13, after C4) adds `harper.js` and `@mozilla/readability` (§6).

## 2. Constraints that ruled libraries in or out

- **CSP** (index.html:5, `script-src 'self'`). No `eval` or `new Function`, no remote scripts or services, and no WebAssembly (MDN: it needs `'wasm-unsafe-eval'`). This rules out:
  - libavoid-js and @hpcc-js/wasm-graphviz (WebAssembly);
  - the online PNG/PDF exporters of SVAR and DHTMLX (remote services).
  Injecting a `<style>` element is fine under `style-src 'unsafe-inline'`.
- **Single IIFE bundle.** `npm run build` runs esbuild `--bundle --format=iife --minify` into one `dist/renderer.js`, with no code splitting or lazy loading. Every adopted byte ships to every user. Packages marked `sideEffects: true` cannot be tree-shaken (dagre, @flatten-js/core), so their full minified size is the cost.
- **html-to-image export.** Boards and plan charts reach the forum as PNGs made by cloning the DOM (`rasterizeWhiteboard`, `rasterizePlanChart`). Two kinds of library would need a second render and export path:
  - libraries that draw on `<canvas>` (Konva, fabric, Excalidraw);
  - libraries that own their DOM, state and theme (React Flow, maxGraph, SVAR, DHTMLX, @svar-ui/react-kanban).
  CSS transforms export as drawn, so rotation needs no library. html-to-image's one open transform issue (#296) is Safari-only.
- **React 19 and the Board's DOM.** React ^19.3.0 renders only the chrome. Board items are plain DOM built by `itemElement`, so a library that wraps each item in a React component (react-rnd) does not fit. Libraries with their own pointer and selection systems (moveable, interact.js) would fight the Board's gesture pipeline and the artboard's CSS scale (canvas.js:440).
- **Licence.** MIT, Apache-2.0, ISC or BSD. Copyleft licences (GPL, LGPL, MPL, EPL) and licence-key or commercial SDKs (tldraw, Bryntum, Syncfusion) are flagged and excluded. Open-core libraries are judged on their free edition only.
- **Maintenance.** A release within about the last 12 months.
- **Project rules.** JavaScript only, while shadcn-registry copy-ins ship as TSX. shadcn components come via the CLI. No second primitives library next to `radix-ui` (`@base-ui/react`, react-aria-components).
- **Test runtime.** Pure modules run under `node --test` on Node 22.16, which has no `Temporal`. The Electron 44 renderer does have it.
- **Cost against own code.** A library must remove more code than it costs in bytes and API to learn. For example, 88 kB to replace ~40 lines of geometry is a bad trade.

## 3. Recommendations by need

### Flowchart (`docs/plans/flowchart.md`)

| Need | Recommended | Licence | Size added | Fit | Plan / phase |
|---|---|---|---|---|---|
| Auto-layout (Mermaid import, `flow.insert` without coordinates) | `@dagrejs/dagre` ≥ 3.1.1. It re-exports `@dagrejs/graphlib` 4.0.5, so `package.json` lists only dagre | MIT (both) | 59.7 kB / 20 kB with graphlib (40 % of the plan's 150 kB budget) | Pure JS, no eval. Supports compound graphs (subgraphs) and per-cluster `rankdir`. Needs ≥ 3.1.1 because of a module-state bug in 3.1.0 (PR #515). An edge that ends on a cluster crashes it (open issues #236/#238), so such edges are redirected to a member node first | Flowchart Phase 4 |
| Free rotation: handle, rotated resize, hit-test, bounds | Own code (~120 lines), with the installed shadcn `Input` for the angle field and lucide `RotateCw` | — | 0 | One more handle and gesture in the Board's pipeline; `transform: rotate()` exports as drawn. Konva's Transformer (MIT) is the reference for rotated resize, ported rather than imported | Flowchart Phase 0 (geometry), Phase 2 (UI) |
| Three connector labels (source, middle, target) | Own code (~60 lines, a data-model change) and the installed shadcn `Popover` | — | 0 | No surveyed library has more than one label per edge | Flowchart Phase 1b |
| Geometry (rotate a point, point in polygon, ray against polygon) | Own code (~40 lines). @excalidraw/math (MIT) is the reference for the ported functions | — | 0 | Smaller than any dependency | Flowchart Phase 0 |
| Connector routing (ortho, curve, waypoints) | Own code | — | 0 | `@xyflow/system` exits only on four fixed sides, with no waypoints | Flowchart Phases 0 and 3 |
| Mermaid flowchart parsing | Own code (~300 lines) | — | 0 | The only standalone parser is 1.1 MB (§4) | Flowchart Phase 4 |
| Ribbon, flyouts, shape picker | Installed shadcn: Popover, DropdownMenu, Select, Toggle, ToggleGroup, Dialog, Input | installed | 0 | — | Flowchart Phases 1a–2 |

### Gantt + Kanban (`docs/plans/gantt-kanban.md`)

| Need | Recommended | Licence | Size added | Fit | Plan / phase |
|---|---|---|---|---|---|
| Gantt chart | Own SVG `ChartView` over `schedule.mjs` (~150 lines CPM) and `gantt-layout.mjs` | — | 0 | One renderer draws the workspace, the chart node and the export | Gantt Phase 3 |
| Kanban board | Own `Kanban.jsx` / `Card.jsx` | — | 0 | No library has per-plan columns, the tag map, draft cards or bulk selection | Gantt Phase 1 |
| Kanban / Backlog drag | Own `drag.js` + `drag.mjs` (~150 lines, the Sidebar `dragRow` pattern) | — | 0 | Same pointer model as the Gantt gestures | Gantt Phases 0–1 |
| Backlog table | Own code (~60 lines over `tree(plan)`) | — | 0 | One-column sort, hidden columns and expand/collapse only | Gantt Phase 2 |
| Date math and labels | Own `dates.mjs` (~80 lines) and native `Intl.DateTimeFormat` | — | 0 | Handles per-plan workdays and holidays | Gantt Phase 0 |
| Date input | Native `<input type="date">` (Chromium 152) for typing + shadcn `calendar` (react-day-picker 10) in a popover (`DateField`, user request 2026-10-06) | MIT | ~79 kB min | A picker that still takes typing | Gantt Phase 1, then gantt-kanban.md §6.13 |

### Shared and agent layer

| Need | Recommended | Licence | Size added | Fit | Plan / phase |
|---|---|---|---|---|---|
| Multi-line text field | shadcn `textarea` via CLI (copied source, no new npm package *unverified*) | shadcn *unverified* | small *unverified* | The one new UI component; whichever plan lands first adds it | Gantt Phase 1 (ticket dialog), flowchart Phase 4 (import dialog) |
| PNG export | `html-to-image` | installed | 0 | Exports CSS transforms as drawn | All plans |
| Icons | `lucide-react` | installed | 0 | `RotateCw`, `SquareKanban`, `ChartGantt`, `Tag`, … | All plans |
| Agent request card, status popover, Settings switch | shadcn `card`, `popover`, `badge`, `switch` | installed | 0 | One card, one popover and one switch | Agent layer Phase 2 |

## 4. Considered, not adopted

Rotation and handles
- moveable / react-moveable and the @scena packages (MIT): no release since Dec 2023, and a second selection, handle and snap system; react-moveable is 229 kB / 74 kB.
- interact.js 1.10.28 (MIT, 97 kB / 29 kB): no rotate action, and its resize is not rotation-aware.
- react-rnd (MIT): one React component per item, and no rotation.
- Konva / react-konva and fabric (MIT): `<canvas>` renderers, which lose contenteditable labels, inline SVG shapes and the DOM export.

Geometry
- @flatten-js/core 1.6.14 (MIT, 88 kB / 22 kB, `sideEffects: true`): 88 kB to replace ~40 lines.
- transformation-matrix 3.1.0 (MIT, 14.7 kB / 4.9 kB): rotation about the centre is 6 lines of code, and the last release was 13 months ago.
- @excalidraw/math (MIT, ≈ 45 kB with @excalidraw/common): only commit-hash pre-release versions exist; kept as a reference.
- kld-intersections, bezier-js, polygon-clipping, d3-shape, gl-matrix: stale or more than needed.

Routing and layout
- libavoid-js (LGPL-2.1): its WebAssembly is blocked by the CSP, and the licence is copyleft.
- obstacle-router 0.1.2 (LGPL-2.1, pure JS): copyleft licence and a 0.1.x release; reconsider only if LGPL is accepted (flowchart §11 Q1).
- perfect-arrows, @blocksuite/connector (MPL-2.0): stale.
- @xyflow/system (MIT, 100 kB / 35 kB): its edge helpers exit on four fixed sides, with no waypoints and one label.
- elkjs 0.12 (EPL-2.0 or GPL-3.0): licence flag, and more than 20× the size of dagre.
- d3-dag (MIT, 136 kB / 42 kB): no compound graphs.
- @antv/layout (MIT, 11.4 MB unpacked): a whole suite for one layout.
- @hpcc-js/wasm-graphviz (Apache-2.0): WebAssembly, blocked by the CSP.

Mermaid
- mermaid 12 (MIT): a full renderer pulling in d3, cytoscape, elkjs and katex, several MB inside the IIFE.
- @mermaid-js/parser (MIT): has no flowchart grammar.
- mermaid-parser-bundle 0.2.1 (MIT): standalone and CSP-safe, but one 1.1 MB entry that carries all 34 grammars.
- mermaid-flowchart-parser (ids and edges only), beautiful-mermaid (needs elkjs), @excalidraw/mermaid-to-excalidraw (needs the full `mermaid`).

Whole diagram frameworks
- React Flow (`@xyflow/react`), maxGraph (Apache-2.0), JointJS (MPL-2.0), AntV X6, Rete.js: each owns its container, model and events, so it would be a second engine; React Flow also has no node rotation.
- tldraw: licence key, watermark and licence telemetry.
- @excalidraw/excalidraw (MIT): its own canvas editor and state, and fonts from a CDN unless self-hosted.

Drawing style
- roughjs 4.6.6 (MIT, 27 kB / 8.8 kB): no release since 2023-11, and a sketchy style was not requested.
- perfect-freehand (MIT, 4.4 kB): a new stroke format, and pressure-sensitive pen strokes were not requested.

Drag and drop
- @dnd-kit/react 0.5.0 (MIT, React 19): pre-1.0 with a breaking minor release about every 2 months; 7 @dnd-kit packages, ~102 kB / 33 kB.
- @dnd-kit/core + sortable (MIT): no release since 2024-12.
- @hello-pangea/dnd 18.0.1 (Apache-2.0, ~100 kB): no release since 2025-02, and it handles lists only.
- Pragmatic drag and drop 4.0 (Apache-2.0), @formkit/drag-and-drop 0.6 (MIT): native HTML5 drag, a second model next to the pointer gestures.
- @use-gesture/react: no release since 2024-03.
- react-aria-components: a second primitives library.
- swapy (GPL-3.0), react-dnd, muuri, react-sortablejs, react-movable: copyleft or stale.

Kanban components
- @svar-ui/react-kanban 2.6.0 (MIT): owns its data model, DOM and theme, and undo is PRO.
- Kibo UI, Dice UI, ReUI Kanban: TSX copy-ins on the legacy dnd-kit. Dice and ReUI add `@base-ui/react`, and ReUI's full boards are paid.

Gantt
- SVAR React Gantt 2.7.3 (MIT core): lag, auto-scheduling, critical path, baselines, the working-day calendar and export are PRO.
- DHTMLX Gantt Community 10.0.3 (MIT): critical path, baselines, calendars, auto-scheduling, today markers, unscheduled tasks and undo are PRO, and export goes through an online service.
- frappe-gantt 1.2.2 (MIT): FS dependencies only, with no lag, critical path or baseline.
- Kibo UI Gantt: no dependency links, and it adds 6 runtime dependencies.
- gantt-task-react: no release since 2022.
- wx-react-gantt: GPLv3.
- jsgantt-improved: no lag, critical path or baseline.
- react-calendar-timeline: beta, with no dependency links.
- vis-timeline: no dependency links, and it needs moment and hammerjs.
- Bryntum, Syncfusion, gantt-schedule-timeline-calendar: commercial or licence key.
- mermaid gantt: a static image, ~3 MB.

Tables, dates and pickers
- TanStack Table 9 (MIT, ~45 kB): ~60 own lines cover the Backlog.
- TanStack Virtual 3 (MIT): no virtualisation is needed below ~500 cards, and it would break the full-height export.
- date-fns 4.4, dayjs 1.11 (MIT): their business-day helpers know only Mon–Fri.
- `Temporal`: missing from Node 22.16.
- @js-temporal/polyfill 0.5.1 (ISC, ~230 kB): last release 2025-03.
- react-day-picker 10 (MIT, ~60 kB estimated): the native date input is enough. Added 2026-10-06 at the user's request (Date input row).

## 5. When to revisit

- @dnd-kit/react: at 1.0, if screen-reader drag announcements become a requirement (Gantt §9).
- TanStack Table: if the Backlog needs grouping, multi-sort, column resizing or facets. TanStack Virtual: above ~500 cards (Gantt §13).
- @thi.ng/geom-isec (Apache-2.0; tree-shakes to a few kB): if Phase 3 routing needs polygon offsets (flowchart §12).
- obstacle-router: if full obstacle avoidance is wanted and LGPL is accepted (flowchart §11 Q1).
- elkjs: if swimlane-aware layout is needed and its licence is accepted (flowchart §12).
- roughjs: if a hand-drawn style is requested, accepting that it is stale.
- `Temporal`: when the test runtime ships it.

## 6. Other new dependencies (not UI)

- `@tiptap/markdown`, agent layer Phase 0 (Markdown in and out of drafts). *Unverified*: it was not part of this survey. The agent plan checks that it exists for the installed `@tiptap/*` 3.31 line before Phase 0. If it does not, the fallback is `marked` (also *unverified*) plus a ~150-line serializer.
- `harper.js` (Apache-2.0) and `@mozilla/readability` (Apache-2.0), the local assistant's live grammar check and research fetch (agent plan §13.14–§13.15, after C4). *Unverified* versions and sizes. Harper's WebAssembly runs in main under Node, never in the renderer; Readability runs in the renderer over the built-in `DOMParser`, so no `linkedom` / `jsdom`.
- No other runtime dependency is planned. The CSP stays unchanged in all three plans.
