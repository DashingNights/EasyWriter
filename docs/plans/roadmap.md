# DAF Writer — implementation roadmap (flowchart, Gantt/Kanban, agents)

Planning only. Paths are relative to `A:/Programming Dumpster/DAF Writer/`. This is the order in which the three plans are built: `docs/plans/flowchart.md`, `docs/plans/gantt-kanban.md`, `docs/plans/agent-automation.md`. It assigns their phases to stages, gives every stage its files, acceptance and dependencies, and fixes who may edit a shared file when. User decisions of 2026-10-06 are applied: the sidebar's Flowcharts tab opens a per-thread flowchart library with a full editor (flowchart plan §3.8–§3.9, §4, §5.10), an inserted library flowchart is Synced (default) or a Copy (§5.1), the bottom toolbar gets the insert buttons for the new elements (flowchart and plan chart), and every open question in the three plans takes its stated default (§8 below). A later decision that day adds user prefabs, favourites and a reorderable shape list, to be built after the flowchart fundamentals (flowchart plan Phase P, stage B5 below). Line numbers are the plans' own; each stage re-anchors the ones it uses before editing, and SPEC.md wins where they drift.

## 1. Order at a glance

```
Stage 1  shared shell (one engineer)
   ├── Track A  A1 → A2 → A3 → A4          Gantt / Kanban
   └── Track B  B1 ─┬→ B2 → B3 → B5         flowchart (B5: prefabs, favourites, shape order)
                B4 ─┘                       flowchart library + synced canvases (needs Stage 1 only)
Integration     C1 (after A3, B2, B4) · C2 (after B5) → C3
Agent layer     C4 (after A4 and C3)
```

- Tracks A and B share no source file (§7): they need not run in lockstep. The wave columns in §7 are the nominal schedule.
- B2 starts after both B1 and B4: B2 edits `src/app/flows.js` and `src/app/tools-flow.js`, which B4 owns before it.
- B5 starts after the fundamentals (B3, and B4 before it). It extends B3's `ShapePicker` and edits `whiteboard.js` and `controls.jsx` after B3, so C2 waits for B5.
- Agents come last (user decision): nothing before C4 registers a command, and the local multimodal assistant (automation plan §13) comes after C4.

## 2. Rules for every stage

- **Harness**: one run of `npm test && npm run smoke` (package.json:10-11) plus one manual acceptance pass per stage. No exhaustive matrices.
- **One owner per hot file per wave**: two stages that run at the same time never own the same file. A stage edits only the files §7 gives it.
- **Lists are spread, not shared**: Stage 1 turns every list that several features extend into a spread of per-feature modules, so later stages append to their own module:
  - `src/app/tools.js`: `TOOLS = [...CORE, ...PLAN_TOOLS, ...FLOW_TOOLS]` from `src/app/tools-plan.js` and `src/app/tools-flow.js`.
  - `src/app/components/Dialogs.jsx`: `FORMS = {...CORE, ...PLAN_FORMS, ...FLOW_FORMS}` (Dialogs.jsx:47) from `components/plan/forms.jsx` and `components/flows/forms.jsx`.
  - `src/app/actions.js` `sampleDoc` (817-880): `[...core, ...planSample(), ...flowSample()]` from `src/app/samples/plan.js` and `samples/flow.js`.
  - Where a shared file cannot be avoided, additions sit in delimited sections (`// --- plan ---`, `// --- flow ---`). SPEC.md is shared by section: each stage owns the sections §3–§6 name.
- **Stubs instead of later edits**: Stage 1 wires every call site in the hot files to stub exports (`openPlan`, `insertPlanChartDialog`, `initPlans`, `flushPlans` in `src/app/plans.js`; `openFlows`, `insertFlowchartDialog`, `initFlows`, `flushFlows` in `src/app/flows.js`). Later stages fill the stubs in their own modules and do not reopen `actions.js`, `views.js`, `Toolbar.jsx` or `QuickTools.jsx`.
- **Gates**: every control a stage gates reads `src/app/gates.mjs` (automation plan §3.7), seeded in Stage 1; never an inline condition. Commands that arrive in C4 call the same gates.
- **Agent rules already fixed** (they bind the stages that write the command contracts): precise edits (automation plan §4.3 #11), per-entry commands, gates shared by UI and commands, every agent delete asks on every call.
- **Done** = harness green, acceptance passed, the stage's SPEC sections written, and the plan text corrected where the code had to differ.

## 3. Stage 1 — shared shell

- **Goal**: both sidebar tabs switch the main column to a workspace and back; plans and flowcharts have storage and IPC; the two toolbar insert buttons exist (stubs); gates are seeded; the hot files are ready for append-only use.
- **Owner**: one engineer, sole owner of every file below. ≈ 650 lines + 150 test lines; 3–4 days.
- **Files**:
  - `src/file-family.js` (new, CommonJS) + `main.js`: drafts, plans and flowcharts on `fileFamily` (flowchart plan §4); 8 `handle()`s (`plans.*`, `flows.*`); the smoke writer writes every image as `smoke-wb-<i>.png` (one-line loop at main.js:473). `preload.js`: `plans`, `flows` after `drafts`.
  - `src/app/store.js` (`view`); `src/app/views.js` (new: `openWorkspace` / `closeWorkspace`, flowchart plan §5.10, Gantt plan §6.1 order); `src/app/App.jsx` (the `Workspace` host, `EditorPage` inert outside the editor view, `Toolbar` / `SidebarToggle` in the editor view only, `BoardRail` in the editor and flows views).
  - `src/app/components/Sidebar.jsx` (`SidebarNav` footer: Plans above Flowcharts; Gantt plan §6.2).
  - `src/app/components/Toolbar.jsx` + `QuickTools.jsx` (`T.flowchart`, `T.planChart` and their buttons after the canvas button; flowchart plan §5.1, Gantt plan §7.1).
  - `src/app/actions.js` (the only edits there in this roadmap's tracks): `refocusEditor` / `returnFocus` targets, `onKeyDown` (`Ctrl+Alt+P`, `Ctrl+Alt+F`, the workspace early return), `toggleQuickTools` guard, `init` (`initPlans`, `initFlows`, `lastView` last), `flushPlans` / `flushFlows` wherever `commitBoardEdit()` runs and in `openDraft`, the `sampleDoc` spread.
  - `src/app/tools.js` (`toolContext.view`; the predicates on gates; the existing undo/redo entries off in the plan view; the `TOOLS` spread) + new empty `tools-plan.js` / `tools-flow.js`; `components/Dialogs.jsx` (the `FORMS` spread) + new empty `components/plan/forms.jsx` / `components/flows/forms.jsx`; `components/ToolSearch.jsx` (`GROUPS` + `'Plan'`, `'Flowchart'`); `src/app/samples/plan.js` / `samples/flow.js` (empty).
  - `src/app/gates.mjs` (new; the flowchart plan §7.2 table plus the automation plan §3.7 gates for today's controls).
  - `src/app/panzoom.js` (new, extracted from actions.js:76-151: anchor zoom, middle-drag pan, Ctrl+wheel).
  - Stubs: `src/app/plans.js`, `src/app/flows.js`, `components/plan/PlanPage.jsx`, `components/flows/FlowsPage.jsx` (header with the sidebar toggle and Back to editor).
  - `src/components/ui/textarea.jsx` via the shadcn CLI (used by A2 and C3).
  - `src/doc-utils.mjs`: `flowRefs(doc, titleOf?) → [{path, flowId, label}]` (appended).
- **Tests**: `test/file-family.test.mjs` (temp dir: list and summary, save stamps, `.bak`, trash, corrupt set-aside, id check), `test/gates.test.mjs` (every gate has `message` and `fix`; `can()` on fixtures), `test/doc-utils.test.mjs` + `flowRefs`.
- **Acceptance**: harness green and `smoke-wb-0.png` byte-identical to before; manual: both tabs open their stub, Back and Escape return with the focus in the editor, `lastView` restores after a relaunch, the two toolbar buttons toast "lands in Stage B4 / A3", the rail is hidden in the plan stub.
- **SPEC**: §3 (file families `plans/`, `flowcharts/`, `.bak`, trash), §4 (`api.plans.*`, `api.flows.*`, `fileFamily`), new §7g "Sidebar footer and workspaces" (view switch, focus, shortcuts, `lastView`), §7 toolbar list (+2 buttons).
- **Covers**: Gantt Phase 0's main/preload part and the §6.1–§6.2 shell; flowchart §5.1 entry points (button, Ctrl+Alt+F, tab) as stubs; automation §3.7 seed and §4.1 (`fileFamily`).
- **As built (2026-10-06)**, where the code differs from the lines above or the plans: `fileFamily(dir, …)` takes a function returning the folder, has no `idRe` option and also returns `file(id)`; the `.corrupt-<ts>` set-aside applies to `keepPrevious` families only (drafts unchanged). `tools-plan.js` / `tools-flow.js` are empty as listed, so the two palette entries come with A3 / B4. `flushPlans` / `flushFlows` run inside `commitBoardEdit()` (exported) and in `openDraft`. The rail renders in the flows view only while a board is active; `toggleQuickTools` is a no-op in any workspace without one. The undo / redo entries are off in the plan view through `inText`, which needs `view.editor`. `bindPanZoom(area, wrap, zoomTo)` plus `zoomAround(area, wrap, zoom, anchor)`. The workspace host's Escape (App.jsx) goes back to the editor unless a handler inside called `preventDefault`: A2 / B4 mark the Escapes their pages use. Startup restores `lastView` with `remember: false`. Gates for plan columns stay A1's `PLAN_GATES`.

## 4. Track A — Gantt / Kanban

Never edits `whiteboard.js`, `canvas.js`, `controls.jsx`, `BoardRail.jsx`, `ItemRibbon.jsx`, `CanvasBar.jsx`, `src/flow/*`, `flows.js`, `components/flows/*`.

| Stage | Covers | Owns | Acceptance | SPEC | Size |
|---|---|---|---|---|---|
| **A1** | Gantt Phase 0 minus storage | `src/plan/dates.mjs`, `schedule.mjs`, `plan-model.mjs`, `gantt-layout.mjs`, `plan-commands.mjs`, `components/plan/drag.mjs`, `test/fixtures/plan-sample.json`, their tests | the Gantt §3.7 fixture table verbatim in `test/schedule.test.mjs` | — (documented with A2) | ≈ 1 200 + 700 test; 3–4 d |
| **A2** | Gantt Phase 1 | `src/app/plans.js` (store, `dispatch`, undo, `openPlan` fill), `components/plan/PlanPage.jsx`, `PlanHeader.jsx`, `Kanban.jsx`, `Card.jsx`, `TicketDialog.jsx`, `drag.js`, `components/plan/forms.jsx`, `tools-plan.js`, `SettingsDialog.jsx` (deleteTag note), `Sidebar.jsx` (thread-row Plan action + count), `store.js` (`planUi`) | harness + manual: card drag incl. the create-tag popup, Ctrl+Z restores it | §7f "Plan workspace", §7 Sidebar thread rows, §7c, §7d | ≈ 1 650; 5–6 d |
| **A3** | Gantt Phase 2 | `components/plan/Backlog.jsx`, `ChartView.jsx`, `src/plan-chart.js`, `components/board/PlanChartBar.jsx`, `App.jsx` (its mount), `src/extensions.js`, `src/doc-utils.mjs` (`replaceWhiteboards` type list, `chartRefs`), `src/export.js` (planChart branch), `samples/plan.js`, `plans.js` (`planSource`, `insertPlanChartDialog` fill) | smoke writes `plan-<n>.png` at the drawn width | §5, §6e "Plan chart node", §7f Backlog | ≈ 1 100; 4 d |
| **A4** | Gantt Phase 3 | `components/plan/Gantt.jsx`, `ChartView.jsx` (gantt), `PlanHeader.jsx` (baseline / auto-schedule / calendar), `src/plan-chart.js` (readability), `samples/plan.js` (gantt chart) | the fixture's critical path A→C→D→M on screen; each gesture one undo entry | §7f Gantt, §6e gantt options | ≈ 900; 4 d |

## 5. Track B — flowchart

Never edits `src/plan/*`, `plans.js`, `components/plan/*`, `extensions.js`.

| Stage | Covers | Owns | Acceptance | SPEC | Size |
|---|---|---|---|---|---|
| **B1** | flowchart Phase 0 | `src/flow/shapes.mjs`, `route.mjs`, `model.mjs`, `whiteboard.js` (Phase 0 part of the flowchart §9 touch list, re-anchored first; incl. `cleanItem` dropping `flow` from canvas items, flowchart §3.9, so B4 never edits whiteboard.js), `samples/flow.js` (sample canvas), `test/flow-*.test.mjs`, `test/whiteboard.test.mjs` fixtures | smoke PNG shows connectors and a 30° diamond; `test/flow-*` green | §6 items, §6b, §6d draft | ≈ 960 + 160; 3–4 d |
| **B4** | flowchart Phase L (library + full editor + sync, flowchart §3.8–§3.9, §4, §5.1, §5.10–§5.11) | `src/flow/library.mjs` (`parseFlow`, `summaryOf`, `validFlow`, `writeBackOk`), `src/app/flows.js` (store, chain, undo, `insertFlowchart`, remove flow, stub fills), `components/flows/FlowsPage.jsx`, `FlowLibrary.jsx`, `FlowEditor.jsx`, `components/flows/forms.jsx` (`insertFlow`), `tools-flow.js` (`flow-library-open`, `flow-new`, `flow-save-to-library`, `flow-unlink`, `text('flowchart')`), `src/canvas.js` (`flow` attr, `flowSource`, `liveBoard`, `commitSynced`, write-through `nodeTarget`, `update()` write-back rule, badge, size helpers), `components/board/CanvasBar.jsx` (Open in library, Unlink, Save to library, edit-bar title, `SizeInput(board)`), `test/flow-library.test.mjs` | harness (`parseFlow` drops bad boards and keeps `rev`; `validFlow`; `writeBackOk` on chain fixtures); manual: New in the library → draw → Insert (Synced) into a draft → edit in place → the library editor shows it; a second synced insert follows live; Ctrl+Z in the draft reverts both; Unlink leaves a copy; delete the record → open draft gets copies, another draft shows "missing" | — (C1 writes §6f) | ≈ 700 + 120; 4 d |
| **B2** | flowchart Phases 1a + 1b + 1c | `whiteboard.js`, `controls.jsx`, `BoardRail.jsx`, `ItemRibbon.jsx`, `tools-flow.js` (connector, label, waypoint entries), `flows.js` (`flowPreset` + `setConnTool` in `insertFlowchart` and the library editor) | `__smokeFlow()` (flowchart §9 Phase 1a) returns `tipsChanged && pngChanged` | §6d, §6c rail / ribbon / keyboard, §7c, §7d lists | ≈ 810; 7–8 d |
| **B3** | flowchart Phase 2 | `src/flow/shapes.mjs` (+ kinds), `model.mjs` (align, `resizeInFrame`), `whiteboard.js`, `controls.jsx`, `BoardRail.jsx` (Arrange), `ItemRibbon.jsx`, `tools.js` (shape entries from `KINDS` replace `SHAPE_INFO`, tools.js:58-68), `tools-flow.js` | `resizeInFrame` fixed-corner tests; the rail fits 1280×720 without scrolling | §6 shapes and `rot`, §6c Arrange, keyboard, §7c | ≈ 800; 5 d |
| **B5** | flowchart Phase P (prefabs, favourites, shape order; user decision 2026-10-06, after the fundamentals; flowchart §3.10, §4, §5.12) | `src/flow/prefab.mjs`, `src/app/shape-list.mjs`, `src/app/prefabs.js`, `components/board/BoardMenu.jsx`, `whiteboard.js` (`onContextMenu`, `boardMenu`, `scaleItem` export, armed prefab, `addCopies(items, at)`), `controls.jsx` (`ShapePicker` sections, stars, reorder, entry menu), `components/flows/forms.jsx` (`prefabName`), `tools-flow.js` (`create-prefab`, `insert-prefab`), `main.js` (`prefabs` fileFamily + 4 `handle()`s), `preload.js` (`prefabs`), `App.jsx` (`<BoardMenu />`), `test/flow-prefab.test.mjs`, `test/shape-list.test.mjs` | harness (prefab normalising and insert scaling; list reducers); manual: select → right-click → Create prefab… → listed under Prefabs → star → in Favourites → a drag-reorder survives a relaunch → insert at the click point → Ctrl+Z removes it | §3 (`prefabs/`, `shapeFavourites`, `shapeOrder`), §4 (`api.prefabs.*`), §6c Board menu, new §6g "Prefabs and the shape list", §7c | ≈ 600 + 150; 4–5 d |

## 6. Integration and the agent layer

| Stage | Covers | Owns | Depends on | Acceptance | SPEC | Size |
|---|---|---|---|---|---|---|
| **C1** | synced flowchart export, smoke, closure | `src/export.js` (live substitution, flowchart §6), `samples/flow.js` (a synced canvas whose record does not exist: `flow: {id: '00000000-0000-4000-8000-000000000001', rev: 3}`), `__smoke` result field `flows: {missingBadge}`, tool-search entry check | A3, B2, B4 | smoke image count = boards + charts; the synced sample renders from its cache; `smoke-ui.png` shows the missing badge; `tool-rank` unchanged | new §6f "Flowchart library and synced canvases" (flowchart §3.8–§3.9, §5.10–§5.11), cross-references in §6d, §6e, §7f | ≈ 150; 2 d |
| **C2** | flowchart Phase 3 (routing) | `src/flow/route.mjs`, `whiteboard.js` (jump option) | B5 (after B3) | `flow-route` tests (no segment crosses a bound box; jumps) | §6d routing | ≈ 300; 3 d |
| **C3** | flowchart Phase 4 minus agents | `src/flow/mermaid.mjs`, `layout.mjs`, `components/flows/forms.jsx` (`importDiagram`), `whiteboard.js` (`WhiteboardPaste.handlePaste`), `canvas.js` (`onPaste` Mermaid), `library.mjs` + `flows.js` (`source` on records), `tools-flow.js` (auto-layout, import, Copy as Mermaid / PNG), `package.json` (`@dagrejs/dagre ^3.1.1`) | C2 (whiteboard.js), B4 | `flow-mermaid`, `flow-layout` tests; bundle delta measured with `esbuild --metafile` and recorded | §6d formats, §7 Import dialog | 4–5 d |
| **C4** | agent layer: automation Phases 0–2, then Gantt Phase 4 and flowchart Phase 4 commands (incl. `flow.library.*`, `flow.link`, `flow.unlink`, `flow.undo/redo`, `{flowId}` addressing, flowchart §7.1; `flow.prefabs.*`, `flow.favourites.*`, `flow.shapes.*`, flowchart §7.3); then automation Phases 3–4 (transport, MCP, migrations) | `src/app/schema.mjs`, `src/doc-path.mjs`, `src/app/digest.mjs`, `src/app/commands/*` (incl. `plan.mjs`, `flow.mjs`, `schema-defs.mjs` `FLOW` record schema), `src/app/commands.js`, `gates.mjs` (remaining gates), `actions.js` (§5.5 split), `store.js`, `main.js`, `preload.js`, `App.jsx` (`AgentAsk`), `StatusBar.jsx`, `SettingsDialog.jsx`, `package.json` | A4, C3 | the plans' Phase exits: `test/smoke/agent-basic.json`, `plan-basic.json`, `flow-agent.json`, `flow-library.json`, `flow-prefab.json` pass; two consecutive agent deletes raise two asks | §8 "Commands and agents" | automation ≈ 7–8 d for Phases 0–2, 5–6 d for 3–4; Gantt Phase 4 1–2 d; flowchart commands with C3's modules |

## 7. File ownership by wave

| File | Stage 1 | Wave 2 (A1 ∥ B1 ∥ B4) | Wave 3 (A2 ∥ B2) | Wave 4 (A3 ∥ B3) | Wave 5 (A4 ∥ C1 ∥ B5) | C2 → C3 | C4 |
|---|---|---|---|---|---|---|---|
| `SPEC.md` (by section) | §3, §4, §7g, §7 toolbar | B1: §6 items, §6b, §6d draft | A2: §7f, §7 Sidebar; B2: §6d, §6c, §7c/§7d lists | A3: §5, §6e; B3: §6 shapes/`rot`, §6c Arrange | A4: §7f Gantt, §6e; C1: §6f + cross-refs; B5: §3, §4 (prefabs), §6c Board menu, §6g, §7c | C2/C3: §6d routing and formats, §7 Import dialog | §8 |
| `main.js`, `preload.js` | sole owner | — | — | — | B5 (`prefabs`) | — | C4 |
| `whiteboard.js` | — | B1 | B2 | B3 | B5 | C2, then C3 | — |
| `canvas.js` | — | B4 | — | — | — | C3 (`onPaste`) | — |
| `CanvasBar.jsx` | — | B4 | — | — | — | — | — |
| `controls.jsx`, `BoardRail.jsx`, `ItemRibbon.jsx` | — | — | B2 | B3 | B5 (`controls.jsx` only) | — | — |
| `src/app/flows.js` | stub | B4 | B2 | — | — | C3 | C4 (read only, through `ctx`) |
| `src/app/tools-flow.js` | empty | B4 | B2 | B3 | B5; C1 checks after B5 | C3 | — |
| `components/flows/forms.jsx` | empty | B4 | — | — | B5 (`prefabName`) | C3 | — |
| `samples/flow.js` | empty | B1 | — | — | C1 | — | — |
| `src/app/plans.js` | stub | — | A2 | A3 | A4 | — | C4 (through `ctx`) |
| `tools-plan.js`, `components/plan/forms.jsx` | empty | — | A2 | A3 | A4 | — | — |
| `samples/plan.js` | empty | — | — | A3 | A4 | — | — |
| `tools.js` | spread, gates | — | — | B3 (`SHAPE_INFO`) | — | — | C4 (`command` field) |
| `Dialogs.jsx`, `ToolSearch.jsx` | sole owner | — | — | — | — | — | C4 (`ToolSearch` commit path) |
| `Toolbar.jsx`, `QuickTools.jsx`, `views.js`, `panzoom.js` | sole owner | — | — | — | — | — | — |
| `Sidebar.jsx` | footer | — | A2 (thread rows) | — | — | — | — |
| `store.js` | `view` | — | A2 (`planUi`) | — | — | — | C4 |
| `App.jsx` | sole owner | — | — | A3 (`PlanChartBar`) | B5 (`BoardMenu`) | — | C4 (`AgentAsk`) |
| `actions.js` | sole owner (all call sites) | — | A2 (reserve: a missed plan call site only) | — | — | — | C4 (§5.5 split) |
| `export.js` | — | — | — | A3 (planChart) | C1 (flow live boards) | — | — |
| `doc-utils.mjs` | `flowRefs` | — | — | A3 | — | — | — |
| `extensions.js` | — | — | — | A3 | — | — | — |
| `SettingsDialog.jsx` | — | — | A2 | — | — | — | C4 |
| `gates.mjs` | sole owner (seed) | — | — | — | — | — | C4 |
| `package.json` | — | — | — | — | — | C3 (dagre) | C4 |

New files not listed belong to the stage that creates them.

## 8. Plan phases and open-question defaults by stage

User decision (2026-10-06): every remaining open question takes its plan's stated default. Where each default is built:

| Stage | Plan phases | Defaults it applies |
|---|---|---|
| Stage 1 | Gantt Phase 0 (main/preload), Gantt §6.1–§6.2 shell; flowchart §5.1 entry points; automation §3.7 seed, §4.1 | Gantt Q1 no split view (a workspace replaces the editor column); Gantt Q3 startup restores `lastView` (both workspaces); flowchart Q8 replaced by the user decision (the tab opens the library) |
| A1 | Gantt Phase 0 (pure) | Gantt Q2 one plan per thread (`plan.create` → `already_exists`); Gantt Q4 `weekOne` off until set |
| A2 | Gantt Phase 1 | Gantt Q1 (Open draft from a card closes the workspace); Gantt Q5 removing a thread keeps its plan ("Without a thread" group) |
| A3, A4 | Gantt Phases 2, 3 | — |
| B1 | flowchart Phase 0 | flowchart Q2 global snapping (no per-canvas override); Q5 no named colour tokens (`STYLE_PRESETS` only) |
| B2 | flowchart Phases 1a–1c | flowchart Q6 labels start with Enter / F2 / double-click only |
| B3 | flowchart Phase 2 | — |
| B4 | flowchart Phase L | flowchart Q7 page zoom only (no canvas-local zoom; the library editor zooms its own area the same way); Q8 (the library) |
| B5 | flowchart Phase P | flowchart Q9 a placed prefab is a copy (no link back); Q10 prefabs belong to the user, not a thread; Q11 a prefab is placed by its top-left at the click |
| C1 | flowchart Phase L closure | — |
| C2 | flowchart Phase 3 | flowchart Q1 two-box obstacle avoidance only (own A*, no LGPL router) |
| C3 | flowchart Phase 4 (UI, formats, layout) | flowchart Q3 keep the Mermaid `source` (canvas attr and library record field); Q4 no draw.io import |
| C4 | automation Phases 0–4; Gantt Phase 4; flowchart Phase 4 commands | automation Q1 show the MCP `clientInfo.name`; Q2 hidden instance quits after 10 min idle; Q3 no audit of raw UI clicks; Q4 empty agent drafts are saved; Q5 forum-illegal Markdown is dropped and listed in `dropped[]`; Q6 no CLI-only mode; Q7 the assistant runs on llama.cpp within 8 GB VRAM (user decision, automation §13.2); Q8 assistant approvals by click only; Q9 its default model was Qwen3.5-4B (Q6_K, Q12), Gemma 4 E4B the runner-up (user decision, automation §13.2); Q19 replaces it with Qwen3.5-9B Q4_K_M at a 16 K context (user decision 2026-10-06, automation §13.2; the 4B's files left on disk are listed in Settings with Delete); Q10 research needs no API key by default (user decision, automation §13.15); Q13 installed models warm at app start, the assistant sleeps after 10 idle minutes and unloads after 30 (user decision, automation §13.2; the dictation's part ships now with SPEC §7h); Q14 the chat panel opens from a button at the bottom right, level with push-to-talk (user decision, automation §13.4) (Q7–Q10, Q13, Q14 and Q19 bind §13, which is built after C4) |

Not scheduled: flowchart Phase 5 (Excalidraw / draw.io export, groups, lock) — after C3, when asked; the local multimodal assistant (automation §13) — after C4.

## 9. Dependencies and duration

| Stage | Needs | Why |
|---|---|---|
| A1, B1, B4 | Stage 1 | spread files, stubs, `fileFamily`, view switch, gates |
| A2 | A1 | reducers, `dispatch` descriptors |
| A3 | A2 | plan store, `planSource` |
| A4 | A3 | `ChartView`, chart node |
| B2 | B1, B4 | `whiteboard.js` after B1; `flows.js` / `tools-flow.js` after B4 |
| B3 | B2 | `whiteboard.js`, rail, ribbon |
| B5 | B3, B4 | `ShapePicker`, `whiteboard.js` and `controls.jsx` after B3; the library editor's Board (B4) |
| C1 | A3, B2, B4 | `export.js` after A3's branch; SPEC §6d to cross-reference; the library |
| C2 | B5 | `whiteboard.js` after B5; `route.mjs` |
| C3 | C2, B4 | `whiteboard.js` after C2; `components/flows/forms.jsx`, `canvas.js` after B4 |
| C4 | A4, C3 | every feature its commands wrap |

Duration with one engineer per track and B4 as a third stream: track B is the critical path, Stage 1 (3–4 d) → B1 (3–4) → B2 (7–8) → B3 (5) → B5 (4–5) → C2 (3) → C3 (4–5) ≈ 29–34 working days; track A (Stage 1 → A1 → A2 → A3 → A4) ≈ 19–22, and C1 (2) fits after A3 beside B3 or B5. With two engineers, B4 follows A1 on track A (A2 starts ≈ 4 days later) or follows B1 on track B (B2 starts ≈ 4 days later). C4 follows.
