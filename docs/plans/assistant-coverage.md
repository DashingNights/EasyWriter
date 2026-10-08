# Assistant coverage index

Date: 2026-10-06. Status: index and backlog for roadmap C4 part 2. SPEC.md stays the contract; this file lists what the
assistant can reach through the command registry, what it cannot, and what to build.

Sources: `src/app/commands/catalogue.mjs` and every module under `src/app/commands/`, the executor `src/app/commands.js`,
gates `src/app/gates.mjs`, tool sets `src/app/commands/tool-sets.mjs`, the palette `src/app/tools.js`, `tools-flow.js`,
`tools-plan.js`, and the plans `agent-automation.md` (7, 13.3, 13.8 to 13.11), `gantt-kanban.md` (8.3) and `flowchart.md`
(7, 7.1, 7.3). Plan references below use the form "AA 13.11" (agent-automation), "GK 8.3" (gantt-kanban) and "FC 7.1"
(flowchart).

Terms:
- Coverage: `full` = a registry command does it; `partial` = a command exists but needs a live selection, a palette entry, or
  misses part of the feature; `none` = no command.
- Access: `yes` = the assistant should have it; `approval` = only through the approval card on every call; `no` = keep it
  out (reason given).
- Risk: `read`, `write`, `destructive` (asks every call), `approval` (asks every call, outward-facing).

## 1. Summary

176 features and values indexed (duplicates between the two index halves merged: page zoom, window zoom, presets).

| Area | Rows | Full | Partial | None | Yes | Approval | No |
|---|---|---|---|---|---|---|---|
| Editor and document | 24 | 19 | 4 | 1 | 21 | 2 | 1 |
| Whiteboards and smart canvases | 36 | 15 | 9 | 12 | 29 | 4 | 3 |
| Flowcharts | 24 | 3 | 9 | 12 | 20 | 2 | 2 |
| Plans (Gantt and Kanban) | 48 | 1 | 8 | 39 | 41 | 3 | 4 |
| Drafts and organisation | 20 | 14 | 5 | 1 | 15 | 4 | 1 |
| App level | 13 | 4 | 4 | 5 | 9 | 0 | 4 |
| Voice and assistant | 11 | 1 | 1 | 9 | 4 | 2 | 5 |
| Total | 176 | 57 | 40 | 79 | 139 | 17 | 20 |

Headline gaps:
1. Application control (AA 13.11) does not exist: no `ui.snapshot`, no `ui.invoke`, no setting, no exclusion markers. It is
   the fallback for every other gap in this file. Section 4 designs it. Built 2026-10-06 (section 4, As built), without the
   setting.
2. Plans are unreachable. About 55 descriptors exist in `src/plan/plan-commands.mjs` and run through `plans.js` dispatch(),
   but `catalogue.mjs` has no `plan.mjs`. Two GK 8.3 ids have no descriptor: `plan.labels.move`, `plan.urls.move`.
3. Library flowcharts cannot be written. `board.*` takes only a doc path, `VIEW_SETS.flows` is `[]`, and `ui.select` /
   `ui.zoom` need `view.editor`. `{flowId}` addressing (FC 7.1) is the largest single board gap.
4. `tool.run` is in the loop's `NEVER` list (`src/app/assistant/loop.js:19`) to keep palette Undo/Redo away from the model.
   Side effect: every palette-only entry (plan tabs, chart freeze, save, select thread) is unreachable.
5. The headless rule (`commands.js:289`) denies every `agent:*` source for `headless: false` commands, including the
   in-window assistant. `threads.openInForum`, `forum.login`, and the planned `view.read`, `view.render`, `ui.snapshot`,
   `ui.invoke` are always denied for it. Fixed 2026-10-06: `agent:assistant` gets the `window.visible` gate instead; other
   agents keep the old rule (`tool.run`'s own check for palette entries is unchanged, and `tool.run` stays in `NEVER`).
6. No text-range addressing. `doc.command setTextSelection` takes absolute positions; `doc.find` and `doc.selection` return
   block-local offsets. Lists, quote, code block, clear formatting and table row/column ops are hard for the model.
7. Several palette entries open a modal without `headless: false` (`import-diagram`, `create-prefab`,
   `flow-save-to-library`, `flowchart`). `tool.run` awaits `entry.run` (`commands/tool.mjs`), so a call blocks until the user
   closes the dialog.
8. `ui.state` reports only the view type: no planId, tab, flowId, plan filter or selection, save state or word count.
9. No `flow.*` namespace at all (`src/app/commands/flow.mjs` missing): library, prefabs, shape list, Mermaid, layout.
10. Board session tool settings and snap rules live in module state plus localStorage (`whiteboard.js:44-47`, `:86`), so
    `settings.patch` cannot reach them.

## 2. Coverage tables

### 2.1 Editor and document

| Feature | Kind | Command | Coverage | Access | Note |
|---|---|---|---|---|---|
| Block style paragraph, H1 to H6 (`Toolbar.jsx:54`, `tools.js:206`) | value | `doc.format {block}` | full | yes | |
| Inline marks bold to inline code (`Toolbar.jsx:59-65`) | value | `doc.format {marks}` | full | yes | |
| Font family, font size, text colour, highlight (`extensions.js:25,57,92,124`) | value | `doc.format {marks}` | full | yes | |
| Alignment (`Toolbar.jsx:81-84`) | value | `doc.format {block:{align}}` | full | yes | |
| Bullet list, numbered list, quote, code block (`Toolbar.jsx:85-88`) | action | `doc.command toggle*` | partial | yes | Selection only. Proposal `doc.setBlockType` |
| Horizontal rule, insert table, titled box (`Toolbar.jsx:89,90,97`) | action | `doc.command`, `doc.insert` | full | yes | |
| Table add/delete row and column (`Toolbar.jsx:92-95`) | action | `doc.command addRow*` (gate `doc.inTable`) | partial | yes | Needs caret in a cell. Delete ops are `write`, should ask. Proposal `doc.table` |
| Delete table (`Toolbar.jsx:96`) | action | `doc.delete` | full | approval | destructive |
| Links (`actions.js:168`) | value | `doc.format {marks:{link}}` | full | yes | Link dialog entry stays `headless:false` |
| Insert whiteboard or canvas block (`actions.js:138`) | action | `board.insert`, `canvas.edit` | full | yes | |
| Insert images as canvases (`Toolbar.jsx:103`) | action | `doc.insert {content:{images}}` | full | yes | Agent supplies data URLs |
| Apply font preset (`actions.js:186`) | action | `doc.format {presetId}` | full | yes | |
| Clear formatting (`Toolbar.jsx:104`) | action | `doc.command unsetAllMarks` | partial | yes | Selection only. Proposal `doc.clearFormat` |
| Undo / redo (`history.mjs:19,32`) | action | `history.undo`, `history.redo`, `history.state` | full | approval | Out of view sets so the model does not undo user typing |
| Selection read (`doc.mjs:165`) | view | `doc.selection`, `ui.state` | full | yes | |
| Text-range selection set (`doc.mjs:80`) | action | `doc.command setTextSelection` | partial | yes | Absolute positions only. Proposal: extend `ui.select` |
| Node selection of a block (`ui.mjs:31`) | action | `ui.select {path}` | full | yes | |
| Find, get, insert, replace, delete blocks (`doc.mjs:140-240`) | action | `doc.find`, `doc.get`, `doc.insert`, `doc.replace`, `doc.delete` | full | yes | `doc.delete` asks |
| Page zoom (`actions.js:101`) | value | `ui.zoom` | full | yes | Also the status bar slider |
| Scroll a block into view (`ui.mjs:68`) | view | `ui.scrollTo` | full | yes | |
| Bottom toolbar, text rail, quick tools, tool search open/close (`Toolbar.jsx:261`) | view | none | none | no | Chrome; each control's action has a command |

(24 rows counted: the font/colour row, the HR/table/box row and the find/get/insert row each stand for the rows the index
listed separately.)

### 2.2 Whiteboards and smart canvases

| Feature | Kind | Command | Coverage | Access | Note |
|---|---|---|---|---|---|
| Tool mode select, text, pen, eraser, shape, connector, canvas (`whiteboard.js:2219`) | mode | `tool.run select/pen/...` | full | yes | Only to hand the user a tool |
| Session tool settings pen, shape, connector, text (`whiteboard.js:44-47, :1120-1132`) | value | none | none | yes | Proposal `board.tools.set` |
| Add text, shapes, strokes, images, canvas items, connectors | action | `board.items.add` | full | yes | |
| Erase / delete items (`whiteboard.js:1957`) | action | `board.items.remove` | full | approval | destructive |
| Item selection, deselect (`whiteboard.js:1344`) | action | `ui.select {path, ids}` | partial | yes | No deselect; no library board. Extend `ui.select` |
| Move, resize, rotate, flip | value | `board.items.update` | full | yes | |
| Text, stroke, shape, connector properties (`ItemRibbon.jsx:87-138`) | value | `board.items.update` | full | yes | 4 index rows |
| Style presets, copy/paste style (`controls.jsx:546`, `whiteboard.js:1801`) | action | `tool.run copy-style` (live selection) | partial | yes | Proposal `board.items.style` |
| Reverse / straighten connector | action | `board.items.update` | full | yes | |
| Quick-connect Ctrl+Arrow (`whiteboard.js:2056`) | action | `board.items.add` (agent computes) | partial | yes | Proposal `board.items.cloneConnect` |
| Alt+Arrow jump to connected item | view | none | none | no | Navigation; `board.get` gives from/to |
| Duplicate Ctrl+J (`whiteboard.js:1931`) | action | `tool.run duplicate` | partial | yes | Proposal `board.items.duplicate` |
| Cut / copy / paste items | action | none | none | no | The clipboard is the user's |
| Z-order (`whiteboard.js:1722`) | action | `board.items.arrange` | full | yes | |
| Align, distribute, same size (`whiteboard.js:1762-1773`) | action | `tool.run align-*` (live selection) | partial | yes | Proposal `board.items.align` |
| Snapping rules and grid (`whiteboard.js:86, :1105`) | value | none | none | yes | Proposal `board.snap.set` |
| Board background (`whiteboard.js:1136`) | value | `board.set {attrs:{bg}}` | full | yes | |
| Whiteboard height, Fit height (`whiteboard.js:1629`) | value | `board.set {attrs:{base}}` | partial | yes | No fit. Extend `board.set` base `'fit'` |
| Delete whiteboard, delete canvas | action | `doc.delete` | full | approval | 2 rows, destructive |
| Image / canvas item reset size, reset crop, crop (`whiteboard.js:1637-1710`) | action | `board.items.update` | partial | yes | Natural size unknown. Proposal `board.items.reset` |
| Canvas Mode enter / Done (`canvas.js:744, :576`) | mode | `canvas.edit`, `canvas.close` | full | yes | |
| Canvas artboard W / H, Fit to content (`CanvasBar.jsx:108-139`) | value | `board.set {attrs:{w,h,frame}}` | partial | yes | No fit. Proposal `board.fit` |
| Canvas displayed width (`canvas.js:267`) | value | `board.set {attrs:{dw}}` | full | yes | |
| Read boards (`board.mjs:208,234,496`) | view | `board.list`, `board.get`, `board.render` | partial | yes | AA 13.8 `board.read` / `board.query` not built |
| Prefab create from selection (`prefabs.js:108`) | action | `tool.run create-prefab` (blocks on dialog) | none | yes | Proposal `flow.prefabs.create` |
| Prefab insert (`prefabs.js:153`) | action | none | none | yes | `flow.prefabs.insert` |
| Prefab list / read (`prefabs.js:56`) | view | none | none | yes | `flow.prefabs.list` |
| Prefab rename / duplicate (`prefabs.js:120,127`) | action | none | none | yes | `flow.prefabs.update`, `.duplicate` |
| Prefab delete (`prefabs.js:136`) | action | none | none | approval | `flow.prefabs.remove` |
| Shape favourites (`prefabs.js:184`) | value | none | none | yes | `flow.favourites.*` |
| Shape list order, reset, read (`prefabs.js:174-207`) | value | none | none | yes | `flow.shapes.*` |
| Rail, ribbon, canvas bar, board menu placement | view | none | none | no | Chrome |

### 2.3 Flowcharts

| Feature | Kind | Command | Coverage | Access | Note |
|---|---|---|---|---|---|
| Open Flowcharts page, open a flowchart, back to editor (`flows.js:282`) | view | `tool.run flow-library-open` | partial | yes | Proposal `ui.view` |
| Library list (`flows.js:148`) | view | none | none | yes | `flow.library.list` |
| Library record read (`flows.js:76,149`) | view | none | none | yes | `flow.library.get` |
| Library filter, thread scope, list/grid view | view | none | none | no | View-local; `flow.library.list {threadUrl}` filters |
| New flowchart (`flows.js:156`) | action | `tool.run flow-new` | partial | yes | No args, no id back. `flow.library.create` |
| Rename / move to thread (`flows.js:169`) | value | none | none | yes | `flow.library.update` |
| Duplicate flowchart (`flows.js:185`) | action | none | none | yes | `flow.library.duplicate` |
| Delete flowchart (`flows.js:193`) | action | none | none | approval | Affects every draft. `flow.library.remove` |
| Library editor items (`FlowEditor.jsx:13-60`) | action | `tool.run` (live board) | partial | yes | Extend `board.*` with `{flowId}` |
| Library editor artboard W / H, fit (`canvas.js:708,723`) | value | none | none | yes | `board.set {flowId}`, `board.fit` |
| Library editor undo / redo (`flows.js:265`) | action | none | none | approval | `flow.undo`, `flow.redo` |
| Library editor zoom / pan (`FlowEditor.jsx:44`) | value | none | none | yes | Extend `ui.zoom` gates |
| Shape panel collapse, width, search | view | none | none | no | Chrome |
| Insert flowchart: new, synced, copy (`flows.js:293,301`) | action | `tool.run flowchart` (blocks on dialog) | partial | yes | `flow.insert` |
| Edits to a synced canvas update every place (`canvas.js:165`) | value | `board.items.*`, `board.set` | full | yes | Descriptions must say it spreads |
| Synced status, title, missing (`canvas.js:133`) | view | `board.list`, `board.get` (id only) | partial | yes | Extend `board.list` result |
| Save to library (`flows.js:320`) | action | `tool.run flow-save-to-library` (blocks) | partial | yes | `flow.link` |
| Unlink (`canvas.js:281`) | action | `ui.select` + `tool.run flow-unlink` | partial | yes | `flow.unlink` |
| Mermaid import (`flows.js:341,385`) | action | `tool.run import-diagram` (blocks) | none | yes | `flow.import` |
| Mermaid export (`flows.js:445`) | action | `tool.run copy-mermaid` (clipboard only) | partial | yes | `flow.export` |
| Copy as PNG (`flows.js:455`) | action | `board.render` | full | yes | |
| Auto layout (`flows.js:418`) | action | none | none | yes | `flow.layout` |
| Graph read and validation (`flow/graph.mjs`) | view | `board.get` (raw) | partial | yes | `flow.graph.get`, `flow.validate` |
| Connect shapes, shape kinds | action | `board.items.add` | full | yes | `flow.connect` optional sugar |

### 2.4 Plans (Gantt and Kanban)

All `plan.*` ids below have a descriptor in `src/plan/plan-commands.mjs` unless marked "new". Registering them is the work;
the descriptor fixes args, risk and undo.

| Feature | Kind | Command | Coverage | Access | Note |
|---|---|---|---|---|---|
| List plans (`plans.js:55`) | view | `plan.list` | none | yes | Not registered |
| Read a plan (`plans.js:60`) | view | `plan.get` | none | yes | |
| Create a plan (`plans.js:329`) | action | `plan.create` | none | yes | |
| Open workspace, switch tab (`plans.js:309,338`) | action | `plan.open` | partial | yes | Palette only, `tool.run` never offered |
| Back to editor (`views.js:39`) | action | `plan.close` | partial | yes | Palette only |
| Rename plan (`plans.js:456`) | value | `plan.update` | none | yes | |
| Delete plan (`plans.js:355`) | action | `plan.delete` | none | approval | destructive |
| Calendar weekdays, week one (`forms.jsx:288`) | value | `plan.update` | none | yes | |
| Holidays (`forms.jsx:295`) | value | `plan.holidays.add` / `.remove` | none | yes | remove asks |
| Auto-schedule, apply schedule | mode | `plan.update`, `plan.schedule.apply` | none | yes | |
| Done column (`Kanban.jsx:72`) | value | `plan.update` | none | yes | |
| Default estimate unit (`forms.jsx:237`) | value | `plan.update` | none | yes | |
| Columns add, edit, move, delete (`plans.js:439,448`) | value | `plan.columns.*` | none | yes | Gates `plan.columnRoom`, `plan.otherColumn` not in `gates.mjs` |
| Estimate units (`forms.jsx:212`) | value | `plan.units.*` | none | yes | |
| Plan labels (`forms.jsx:158`) | value | `plan.labels.*` | none | yes | `plan.labels.move` has no descriptor |
| Saved views (`PlanHeader.jsx:128`) | value | `plan.views.*` | none | yes | |
| Workspace filter and view options, Gantt Show toggles (`PlanHeader.jsx:99`, `Gantt.jsx:44`) | mode | none | none | yes | New `plan.ui.set` |
| Backlog visible columns (`Backlog.jsx:335`) | value | none | none | yes | Fold into `plan.ui.set` |
| Workspace ticket selection, focus | view | none | none | yes | New `plan.select` |
| Create ticket (`plans.js:385`) | action | `plan.tickets.create` | partial | yes | Palette opens dialog only |
| Ticket title, description, priority, estimate, dates, milestone, progress, parent, linked draft (`TicketDialog.jsx`) | value | `plan.tickets.update` | none | yes | 9 index rows |
| Ticket status / column move (`plans.js:416`) | value | `plan.tickets.move` | none | yes | |
| Ticket order (`Backlog.jsx:157`) | action | `plan.tickets.reorder` | none | yes | |
| Delete tickets (`plans.js:400`) | action | `plan.tickets.delete` | none | approval | destructive |
| Ticket labels | value | `plan.tickets.labels.*` | none | yes | |
| Dependencies (`Gantt.jsx:377`) | value | `plan.deps.*` | none | yes | |
| Checklist (`TicketDialog.jsx:149`) | value | `plan.checklist.*` | none | yes | |
| Ticket links (`TicketDialog.jsx:163`) | value | `plan.urls.*` | none | yes | `plan.urls.move` has no descriptor |
| Open a ticket link externally | action | none | none | no | Opens arbitrary URLs; forum links use `threads.openInForum` |
| Baseline set / clear | action | `plan.baseline.*` | none | yes | |
| Schedule read, ready tickets | view | `plan.schedule`, `plan.ready` | none | yes | |
| Plan undo / redo (`plans.js:299`) | action | `plan.undo`, `plan.redo` | partial | no | Shared stack; step-line Undo instead |
| Copy as Markdown / Mermaid (`plans.js:462`) | view | `plan.describe` | none | yes | |
| Export plan JSON file (`plans.js:468`) | action | `plan.get` | partial | no | File dialog is the user's |
| Import tasks (`plan-commands.mjs:200`) | action | `plan.import` | none | yes | Whole-file replace stays user-only |
| Insert plan chart (`plans.js:524`) | action | `plan.insertChart` | partial | yes | Palette only |
| Plan chart options (`PlanChartBar.jsx:125-284`) | value | `plan.chart.set` | none | yes | |
| Chart freeze, refresh, live, full width | mode | `plan.chart.set` | partial | yes | Palette only |
| Delete plan chart block | action | `doc.delete` | full | approval | |
| List charts in draft | view | `plan.chart.list` | partial | yes | `doc.get` shows attrs |
| Render chart to PNG | view | `plan.render` | none | no | Until vision phase C, like `board.render` |

(48 rows counted; the ticket-field row stands for 9.)

### 2.5 Drafts and organisation

| Feature | Kind | Command | Coverage | Access | Note |
|---|---|---|---|---|---|
| List, read, create, open drafts (`drafts.mjs:32-86`) | action | `drafts.list`, `.get`, `.create`, `.open` | full | yes | 3 rows |
| Delete draft (`drafts.mjs:102`) | action | `drafts.delete` | full | approval | |
| Save now (`actions.js:328`) | action | none (`tool.run save`) | partial | yes | Proposal `drafts.save` |
| Draft thread, status tag (`drafts.mjs:134,149`) | value | `drafts.setThread`, `drafts.setTag` | full | yes | 2 rows |
| Move / reorder drafts | action | `drafts.move`, `drafts.reorder` | full | yes | |
| Folders create, rename, delete (`settings.mjs:181-207`) | value | `folders.*` | full | yes | |
| Folder reorder, collapse (`actions.js:632,647`) | value | none | none | yes | Proposal `folders.move`, `folders.update` |
| Status tags (`settings.mjs:81-150`) | value | `tags.*` | full | yes | |
| Thread list add, remove, select (`threads.mjs:14-59`) | value | `threads.*` | full | yes | |
| Find my threads (`threads.mjs:75`) | action | `threads.discover` | full | yes | |
| Open thread in forum window (`threads.mjs:102`) | action | `threads.openInForum` | partial | yes | Risk `approval` since 2026-10-06: the assistant asks on the card (outward-facing) |
| Forum login / status (`export.mjs:80,91`) | action | `forum.status`, `forum.login` | partial | approval | Headless rule; user still types credentials |
| Push to forum (`export.mjs:41`) | action | `push.prepare` | full | approval | |
| Unpush (`drafts.mjs:117`) | action | `drafts.unpush` | full | approval | |
| Export preview (`export.mjs:25`) | view | `export.preview` | full | yes | |
| Status bar save state, word count (`StatusBar.jsx:47-56`) | view | `forum.status` | partial | yes | Extend `ui.state` |
| Agents popover, Disconnect (`StatusBar.jsx:21-45`) | action | `app.info` | partial | no | Disconnect is the user's control over access |

### 2.6 App level

| Feature | Kind | Command | Coverage | Access | Note |
|---|---|---|---|---|---|
| Settings: forum width, theme, base font and size, undo history, sidebar, selected thread (`settings.mjs:16-24`) | value | `settings.get`, `settings.patch` | full | yes | `historyLimit` lowering trims undo history at plain write risk |
| Formatting presets add, edit, delete, order (`SettingsDialog.jsx:331`) | value | none | none | yes | AA 7/12 keep presets Settings-only; needs a user decision. Proposal `presets.*` |
| Hidden settings lastDraftId, lastView, planTab, maps | value | `settings.get` | partial | no | User state, written through drafts.* / plan.open |
| Allow local AI agents switch (`SettingsDialog.jsx:500`) | value | `settings.get` | partial | no | An agent must not grant agent access |
| Open Settings dialog | action | none | none | no | Every key has its own command |
| Page navigation Editor / Plans / Flowcharts (`views.js:48`) | action | none | none | yes | Proposal `ui.view` |
| Window zoom Ctrl+= / - / 0 (`main.js:378`) | value | none | none | yes | Proposal `ui.windowZoom` (P3) |
| Title bar colours (`App.jsx:61`) | value | none | none | no | Derived from theme |
| Sidebar show/hide | mode | `settings.patch` | full | yes | |
| Notices (`ui.mjs:83`) | action | `ui.notice` | full | yes | |
| Tool search and quick tools entries (`tool.mjs:22,37`) | action | `tool.list`, `tool.run` | partial | yes | `tool.run` never offered |
| Shortcuts list | view | `tool.list` | partial | yes | Global shortcuts not listed |
| App info, capabilities, ui state, audit tail (`app.mjs`) | view | `app.info`, `app.capabilities`, `ui.state`, `audit.tail` | full | yes | |

### 2.7 Voice and assistant

| Feature | Kind | Command | Coverage | Access | Note |
|---|---|---|---|---|---|
| Push-to-talk dictation (`dictation.js:183`) | action | none | none | no | Mic opens only while the user holds it (AA 13.4) |
| Dictation transcript read (`dictation.js:22`) | view | none | none | yes | Proposal `dictation.state` |
| Dictation model, language, microphone (`SettingsDialog.jsx:109`) | value | none | none | yes | Proposal `dictation.settings` |
| Dictation install, delete model (`dictation.js:235,260`) | action | none | none | approval | Proposal `dictation.install`, `dictation.deleteModel` |
| Server program, model file, projector, server URL | value | none | none | no | Runs executables or sends data off-machine (AA 13.6) |
| Assistant model, backend, install, delete (`assistant.js`) | value | `settings.get` | partial | no | Would restart or kill its own runtime |
| Assistant server status (`assistant.js:45`) | view | none | none | yes | Proposal `assistant.status` |
| Chat panel controls (`Chat.jsx:336-400`) | action | none | none | no | Its own chrome |
| Approval card Allow / Deny (`AgentAsk.jsx:58`) | action | none | none | no | User click only |
| Audit log | view | `audit.tail` | full | yes | |
| Application control fallback (AA 13.11) | action | none | none | approval | Section 4 |

## 3. Command backlog

Deduplicated. Priority: P1 = C4 part 2 first waves, P2 = next, P3 = when asked. "Plan" = where a plan already lists the id
("new" = no plan lists it yet; add it to AA 7 when built). Undo `doc` = one TipTap step; `own` = the record's own stack;
`none` = no undo.

### 3.1 Cross-cutting fixes (no new id)

| Fix | Where | Priority |
|---|---|---|
| Headless rule checks window visibility, not the agent source: new gate `window.visible` (subject `ui`, `ui.state` already reports `visible`). Message "The window is not visible", fix "Bring DAF Writer to the front". `agent:assistant` passes while visible; MCP agents stay denied for `headless:false` until AA phase 4 decides. Built 2026-10-06 (subject `window`). | `commands.js:289, :351` | P1 |
| `tool.run`: block only the palette Undo/Redo entries, not the whole command. Remove `tool.run` from `NEVER`, refuse entries whose id is `undo` / `redo` inside `tool.mjs`. | `loop.js:19`, `commands/tool.mjs` | P1 |
| Mark dialog-opening palette entries `headless:false`: `import-diagram`, `create-prefab`, `flow-save-to-library`, `flowchart`. Replace later by `flow.import`, `flow.prefabs.create`, `flow.link`, `flow.insert`. | `tools-flow.js`, `tools.js` | P1 |
| Set `entry.command` on palette entries once their command exists, so `tool.run` maps to it. | `tools.js`, `tools-plan.js`, `tools-flow.js` | P2 |
| `ui.state` result adds `view.planId`, `view.tab`, `view.flowId`, `plan: {filter, options, selection}`, `saved`, `saveError`, `words`, `snap` rules, board session tools. | `commands/ui.mjs` | P1 |
| `doc.command deleteRow` / `deleteColumn` ask (destructive), as `deleteTable` does. | `commands/doc.mjs:80` | P1 |
| `settings.patch historyLimit`: refuse values below the current history length unless `risk: approval` (ask). | `commands/settings.mjs:58` | P2 |
| Drop `selectedThread` from `settings.patch`; `threads.select` owns it. | `commands/settings.mjs` | P3 |
| Command descriptions for `board.items.*` and `board.set` say that a synced canvas writes to every draft that uses it. | `commands/board.mjs` | P1 |
| Add global shortcuts (Ctrl+S, Ctrl+\, Ctrl+K, Alt+1..9, Ctrl+Alt+W/C/F, Ctrl+Shift+A) as palette entries with `shortcut`, so `tool.list` reports them. | `tools.js` | P3 |
| Tool sets: `VIEW_SETS.plan` = `plan.get`, `plan.tickets.create`, `plan.tickets.update`, `plan.tickets.move`, `plan.ui.set`, `plan.select`; `VIEW_SETS.flows` = `flow.library.list`, `flow.library.get`, `board.get`, `board.items.add`, `board.items.update`, `flow.import`. Both under `MAX_SET` (7000), checked by `test/tools-schema.test.mjs`. Add `plan` and `flow` to `CATEGORIES`. | `tool-sets.mjs` | P1 |

### 3.2 New gates

| Gate | Subject | Message | Fix | Used by |
|---|---|---|---|---|
| `window.visible` | ui | The window is not visible | Bring DAF Writer to the front | every `headless:false` command |
| `ui.control` | settings (`assistant.uiControl`) | Application control is off | Settings > Assistant > Let the assistant press buttons | `ui.snapshot`, `ui.invoke` (built 2026-10-06 as `settings.assistant.uiControl`, on by default, checked in the executor's policy step, not as a gate; section 4 As built) |
| `dialog.none` | ui (`state.dialog`, open Radix dialog) | A dialog is open | Finish or close the dialog first | `ui.invoke`, plan and flow writes that race a form |
| `plan.exists` | plan | The thread has no plan | Create one with plan.create | `plan.open`, `plan.insertChart` |
| `plan.columnRoom`, `plan.otherColumn` | plan | (from PLAN_GATES) | (from PLAN_GATES) | `plan.columns.add`, `.remove` |

`subjectOf` gains `settings` and `plan`. `flow.present` and `history.canUndo` resolve their subject from a `flowId` arg (the
record, `canUndoFlow(flowId)`). `ui.zoom` and `ui.select` accept `view.editor` OR (`view.flows` + `flow.open`).

### 3.3 `ui.*`

| Id | Args | Risk | Undo | Gates | Reuse | Pri | Plan |
|---|---|---|---|---|---|---|---|
| `ui.snapshot` | `{marks?, area?, cursor?, maxTokens?}` | read | none | `ui.control`, `window.visible` | new `src/app/assistant/ui-tree.mjs` (section 4) | P1 | AA 13.11 |
| `ui.invoke` | `{snap, ref, action, value?, key?}` | write (asks per control class) | none | `ui.control`, `window.visible`, `dialog.none` | section 4 | P1 | AA 13.11 |
| `ui.view` | `{page:'editor'\|'plan'\|'flows', flowId?}` | write | none | `flow.present` when flowId | `showPage` (`views.js:48`), `openFlows` (`flows.js:282`), `closeWorkspace` | P1 | new (merges `ui.showPage`) |
| `ui.select` (extend) | add `{path, from, to}` (block-local, as `doc.find`); `ids: []` deselects; live library board | write | none | `doc.open` + `view.editor`, or `view.flows` + `flow.open` | `doc.format` offset mapping, `Board.select(null)`, `scrollToBlock` | P1 | AA 7 |
| `ui.zoom` (extend) | unchanged | write | none | as `ui.select` | `FlowEditor` `zoomTo` on the board host | P2 | FC 7.1 |
| `ui.windowZoom` | `{dir:-1\|0\|1}` | write | none | none | `api.window.zoom(dir)` | P3 | new |

### 3.4 `doc.*`

| Id | Args | Risk | Undo | Gates | Reuse | Pri | Plan |
|---|---|---|---|---|---|---|---|
| `doc.setBlockType` | `{paths:[PATH] 1..200, type:'paragraph'\|'heading'\|'bulletList'\|'orderedList'\|'blockquote'\|'codeBlock', level?}` | write | doc | `doc.open` | textTools chains (`Toolbar.jsx:85-88`) on `createChain(tr)` after `setTextSelection` over the range, as `doc.format` | P1 | new |
| `doc.clearFormat` | `{path, from?, to?}` | write | doc | `doc.open` | `unsetAllMarks().clearNodes()` as `doc.format` | P2 | new |
| `doc.table` | `{path, op, row, col}` (ops add/delete row/column) | write; delete ops ask | doc | `doc.open` | TipTap table commands after `setTextSelection` in cell | P2 | new |
| `doc.replaceText` | `{path, from, to, text}` | write | doc | `doc.open` | as AA 13.12 | P2 | AA 13.12 |

### 3.5 `board.*`

| Id | Args | Risk | Undo | Gates | Reuse | Pri | Plan |
|---|---|---|---|---|---|---|---|
| `board.*` `{flowId}` addressing (`get`, `set`, `items.add/update/remove/arrange`) | `boardRef` oneOf `{path, itemPath?}` / `{flowId}` | unchanged | own for flowId | `flow.present` | `settle()` in `board.mjs` + `commitLibrary` (`flows.js:241`) | P1 | FC 7.1 |
| `board.read` | `{boardRef, cursor?, maxTokens?}` | read | none | `doc.open` + `node.board`, or `flow.present` | `sceneRecords` / `pageRecords` in new `scene.mjs` | P1 | AA 13.8 |
| `board.query` | `{boardRef, near?, type?, text?, limit?}` | read | none | as `board.read` | `queryRecords` | P2 | AA 13.8 |
| `board.items.align` | `{boardRef, ids 2..500, op}` (left, centre, right, top, middle, bottom, distribute-h/v, same-width/height) | write | doc | `doc.open`, `node.board` | `Board.arrangeBoxes` geometry factored to a pure helper | P2 | new |
| `board.items.duplicate` | `{boardRef, ids 1..500, dx?=20, dy?=20}` | write | doc | as above | `freshIds` + `Board.addCopies` offsets | P2 | new |
| `board.items.style` | `{boardRef, ids, preset?:0..9, from?:ID}` | write | doc | as above | `stylePresets(theme)`, `copyStyle` / `pasteStyle` field lists | P3 | new |
| `board.items.cloneConnect` | `{boardRef, id, dir:'n'\|'e'\|'s'\|'w'}` | write | doc | as above | `Board.cloneConnect` | P3 | new |
| `board.items.reset` | `{boardRef, id, what:'size'\|'crop'}` | write | doc | as above | `naturalSize`, `resetSize`, `resetCrop` | P3 | new |
| `board.fit` | `{boardRef}` | write | doc | as above | `fitArtboard` (`canvas.js:723`) | P2 | new |
| `board.set` (extend) | `attrs.base: 'fit'` | write | doc | `node.whiteboard` | `Board.fitHeight` / `extent()` | P3 | new |
| `board.list` (extend) | result `flow: {id, title, missing}` | read | none | `doc.open` | `flowSource.title`, `isMissing` | P2 | new |
| `board.tools.set` | `{tool:'pen'\|'shape'\|'connector'\|'text', patch}` | write | none | none | `Board.setPen`, `setShapeTool`, `setConnTool` (call `saveTools`) | P2 | FC 3.6 |
| `board.snap.set` | `{on?, items?, board?, grid?}` | write | none | none | `Board.setSnap` | P2 | new |

### 3.6 `flow.*` (new module `src/app/commands/flow.mjs`)

Built 2026-10-06 (reliability plan wave 3, flows; SPEC §8 Catalogue `flow.*`): `flow.library.list`, `flow.library.get {flowId,
format}`, `flow.find`, `flow.items.add` / `.update` / `.remove` / `.place` (the `board.*` arguments with `flowId` in place of
`path`, `undo: own` on the record's stack, instead of `{flowId}` addressing on `board.*` in §3.5), `flow.layout {flowId, dir}`,
`flow.insert {flowId, at?}` (synced only), `flow.open` (`headless: false`), `flow.library.create {title, threadUrl?, board?}`,
`flow.library.rename` (in place of `.update`, title only) and `flow.library.delete` (in place of `.remove`). No `flow.present`
gate: the commands answer `not_found` themselves. Group `board` until `CATEGORIES` has `flow`. `FLOW_VIEW_SET` in flow.mjs is the
intended `VIEW_SETS.flows`. Still open from this table: `.duplicate`, `flow.undo` / `.redo`, `flow.link`, `flow.unlink`,
`flow.import`, `flow.export`, `flow.graph.get`, `flow.validate`, the prefab, favourite and shape-list ids.

| Id | Args | Risk | Undo | Gates | Reuse | Pri | Plan |
|---|---|---|---|---|---|---|---|
| `flow.library.list` | `{threadUrl?}` | read | none | none | `flowList()` | P1 | FC 7.1 |
| `flow.library.get` | `{flowId, images?, usage?}` | read | none | none | `loadFlow`, `flowRefs` | P1 | FC 7.1 |
| `flow.library.create` | `{threadUrl?, title?, board? \| graph?}` | write | none | none | `createFlow`, `fromGraph` | P1 | FC 7.1 |
| `flow.library.update` | `{flowId, patch:{title?, threadUrl?}}` | write | none | none | `updateFlow` | P2 | FC 7.1 |
| `flow.library.duplicate` | `{flowId, title?}` | write | none | none | `duplicateFlow` | P2 | FC 7.1 |
| `flow.library.remove` | `{flowId}` | destructive (ask names usage) | none | none | `removeFlow` with the executor ask instead of `confirmDialog` | P2 | FC 7.1 |
| `flow.undo`, `flow.redo` | `{flowId, steps?:1..50}` | write | own | `history.canUndo` (subject `canUndoFlow`) | `undoFlow`, `redoFlow` | P3 (step-line Undo only) | FC 7.1 |
| `flow.insert` | `{at?, flowId?, mode?:'synced'\|'copy', graph?, layout?}` | write | doc | `doc.open` | `insertFlowchart` without the dialog, `fromGraph` | P1 | FC 7 |
| `flow.link` | `{path, title?, threadUrl?}` | write | doc | `doc.open`, `node.canvas`, `flow.unsynced` | `saveToLibrary` without `openDialog` | P2 | FC 7.1 |
| `flow.unlink` | `{path}` | write | doc | `doc.open`, `node.canvas`, `flow.synced` | `CanvasView.unlink` transaction | P2 | FC 7.1 |
| `flow.import` | `{boardRef?, format:'mermaid', text <= 200000, dir?, dryRun?}` | write | doc | `doc.open` (+ `node.board`) | `diagramItems`, `importDiagram` placement | P1 | FC 7 |
| `flow.export` | `{boardRef, format:'mermaid'}` | read | none | `node.board` | `toGraph` + `toMermaid` -> `{text, warnings}` | P2 | FC 7 |
| `flow.layout` | `{boardRef, dir, ids?}` | write | doc | `node.board` | `toGraph`, `layout`, `autoLayout` placement | P2 | FC 7 |
| `flow.graph.get`, `flow.validate` | `{boardRef}` | read | none | `node.board` | `toGraph` | P2 | FC 7 |
| `flow.prefabs.list` | `{}` | read | none | none | `prefabList()` (no thumbnails) | P2 | FC 7.3 |
| `flow.prefabs.create` | `{boardRef, ids 1..500, name?, keywords?}` | write | none | `node.board` | `makePrefab` + `write()` without dialog | P2 | FC 7.3 |
| `flow.prefabs.insert` | `{prefabId, boardRef, at:{x,y}}` | write | doc | `node.board` | `prefabItems`, `freshIds` | P2 | FC 7.3 |
| `flow.prefabs.update`, `.duplicate` | `{prefabId, patch}` / `{prefabId}` | write | none | none | `renamePrefab` body, `duplicatePrefab` | P3 | FC 7.3 |
| `flow.prefabs.remove` | `{prefabId}` | destructive | none | none | `removePrefab` with the executor ask | P3 | FC 7.3 |
| `flow.favourites.add`, `.remove`, `.move` | `{ref, before?}` | write | none | none | `dropShape('favourites', ...)` | P3 | FC 7.3 |
| `flow.shapes.list`, `flow.shapes.order.move`, `.reset` | `{section, ref, before?\|after?}` | read / write | none | none | `shapeLayout`, `dropShape`, `resetShapeSection` | P3 | FC 7.3 |

### 3.7 `plan.*` (new module `src/app/commands/plan.mjs`, run = `plans.js` dispatch)

Register every descriptor in `plan-commands.mjs` as is (GK 8.1): risk, undo and args come from the descriptor. P1 subset:
`plan.list`, `plan.get`, `plan.open`, `plan.close`, `plan.create`, `plan.tickets.create`, `plan.tickets.update`,
`plan.tickets.move`, `plan.tickets.delete` (destructive), `plan.schedule`. P2: the rest (`plan.update`, `plan.delete`,
`plan.columns.*`, `plan.units.*`, `plan.labels.*`, `plan.views.*`, `plan.holidays.*`, `plan.deps.*`, `plan.checklist.*`,
`plan.urls.*`, `plan.tickets.reorder`, `plan.tickets.labels.*`, `plan.baseline.*`, `plan.ready`, `plan.describe`,
`plan.import`, `plan.insertChart`, `plan.chart.set`, `plan.chart.list`). Not offered: `plan.undo`, `plan.redo` (as
`history.undo`), `plan.render` (until vision).

New ids:

| Id | Args | Risk | Undo | Gates | Reuse | Pri | Plan |
|---|---|---|---|---|---|---|---|
| `plan.ui.set` | `{filter?, options?, viewId?, backlogFields?}` | write | none | `view.plan` | `setState({planUi})` as `Gantt.jsx:44-47` setOptions; backlogFields store in `Backlog.jsx` | P1 | new |
| `plan.select` | `{planId, ticketIds}` | write | none | `view.plan` | `setState({planUi:{selection, focusId}})` + scroll into view | P1 | new |
| `plan.labels.move`, `plan.urls.move` | `{planId, id, beforeId?}` | write | own | none | add descriptors | P3 | GK 8.3 |

Plan undo note: the plan stack is shared (`plans.js:299`). The step-line Undo for an `undo: 'own'` plan command checks that
the stack top is the assistant's entry, else it says "Your later change is on top; undo it in the plan first".

### 3.8 `drafts.*`, `folders.*`, `presets.*`, `dictation.*`, `assistant.*`

| Id | Args | Risk | Undo | Gates | Reuse | Pri | Plan |
|---|---|---|---|---|---|---|---|
| `drafts.save` | `{}` | write | none | `doc.open` | `commitBoardEdit(); saveNow()` (`actions.js:328`) | P2 | new |
| `folders.move` | `{folderId, beforeId?\|afterId?}` | write | none | none | `moveFolder` (`actions.js:632`) | P3 | new |
| `folders.update` (replaces `folders.rename`) | `{folderId, patch:{name?, open?}}` | write | none | none | `setFolder`, `toggleFolder` | P3 | new |
| `presets.add`, `presets.update`, `presets.remove` | `{name, fontFamily?, size?, color?, highlight?, bold?, italic?, underline?}` / `{presetId, patch}` / `{presetId}` | write / write / destructive | none | none | `saveSettings({presets})` as `tags.add` | P3 (needs user decision, AA 7/12 say Settings-only) | AA 7 (excluded) |
| `dictation.state` | `{}` | read | none | none | `useDictation` store (`dictation.js:22`) | P2 | new |
| `dictation.settings` | `{patch:{model?, language?, micId?}}` | write | none | none | `saveSettings({dictation})` | P3 | new |
| `dictation.install` | `{model, language?}` | approval | none | none | `install()` (`dictation.js:235`), `slow` | P3 | new |
| `dictation.deleteModel` | `{id}` | destructive | none | none | `deleteModel` (`dictation.js:260`) | P3 | new |
| `assistant.status` | `{}` | read | none | none | `api.assistant.status()` | P3 | new |

## 4. Application control: `ui.snapshot` and `ui.invoke`

Status: built 2026-10-06, see As built below (SPEC section 8 Catalogue, Application control; AA 13.11 records the decision).

User decision 2026-10-06: must implement; it is the most flexible fallback. The registry stays first: the system prompt
says "Use a command when one fits. Use ui.snapshot / ui.invoke only when no command does." Every `ui.invoke` on a control
without a command is logged as a missing command (AA 4.3 #10), so this list shrinks over time.

Change to AA 13.11: that section allows clicks only and bans key events and typing. This design adds `type`, `select` and
an allowlisted `key` action on one element, dispatched in the renderer only, still no coordinates and no OS input. Update
AA 13.11 when this ships.

### As built (2026-10-06)

The build followed the task brief of 2026-10-06 where it differs from the design below:
- Contracts: `ui.snapshot {scope?: view | dialog | menu, page?, query?}` returns `{page, pages, total, groups: [{area, nodes:
  [{ref, role, name, in?, state?, value?, risk?, bounds}]}]}`, about 3 000 tokens a page. `ui.invoke {ref, action: click | type
  | select | key, text?, value?, key?}` returns `{ref, action, name, in?, role, area, changes}`. No `snap` argument: a ref stays
  valid while its element lives (a WeakMap), and a gone element answers `stale`.
- Gates: only `window.visible` (subject `window`), added by the executor to every `headless: false` command of
  `agent:assistant`. Not built: the `ui.control` gate (the off switch came later as a setting, below) and `dialog.none` (an
  open modal sets `aria-hidden` on the rest of the app, so the snapshot lists only the dialog and a ref behind it answers
  `refused {code: hidden}`).
- Off switch and permission mode (added 2026-10-06, automation plan §5.2 and §11 Q21): `settings.assistant.uiControl` (on by
  default; Settings > Assistant "Let the assistant use on-screen controls") false makes the executor refuse `ui.snapshot` and
  `ui.invoke` (`denied {reason: policy}` "On-screen controls are off. Change it in Settings.") and leaves both out of the tool
  list, `commands.index` and `commands.describe`. `settings.assistant.permission` Read only refuses `ui.invoke` (a write) and
  keeps `ui.snapshot`; Ask first asks on the card for every `ui.invoke`, whatever the control (so in Ask first a press inside
  an open dialog is refused at once, as the card cannot show over it); Standard is as below.
- Dialogs are listed (area `dialog`, first), so the assistant can fill a form; the approval card still guards destructive and
  outward-facing controls and cannot show over the user's dialog, so such a press inside a dialog is refused at once. The
  Settings dialog is reachable except the parts marked `data-agent-deny` (Settings > Assistant, the dictation server fields,
  "Allow local AI agents").
- Keys: Enter, Escape, Tab, Space, the four arrows, Backspace, Delete, Home, End (no modifiers). Backspace and Delete reach
  only listed controls; the editor and boards are never listed. Since the review of 2026-10-06 they go only to a text input,
  a textarea or contenteditable (`refused {code: not_a_field}` otherwise), as a list's key handler could remove its selected
  row (a Gantt dependency).
- Risk: `data-agent-risk` on Delete draft, Delete folder, Remove thread from list, Unpush (destructive) and Push to forum, Log
  in / Forum window and a thread row's Open in forum (approval; `threads.openInForum` is `approval` too); the name rules cover
  the rest (since the review also uninstall and reset as destructive, log out and sign out as approval). Deny: `data-agent-deny` plus the fixed roots (assistant panel and
  button, approval card, title bar, editor and boards) and password and file inputs.
- Rate limit 20 calls a minute; `ui.invoke` is refused inside a batch; Stop cancels a waiting card.
- Not built: `data-command` routing and the missing-command log, the Set-of-Marks screenshot (`marks`), the system prompt
  lines beyond the one `TOOL_RULES` sentence, and `test/smoke/ui-control.json` (the acceptance ran as an Electron harness
  instead). Tests: `test/ui-tree.test.mjs`.

### 4.1 Where it runs

- Renderer, in-process. No CDP, no `webContents.sendInputEvent`, no OS input. Events are dispatched on the target element
  only.
- Files:
  - `src/app/assistant/ui-tree.mjs` (pure, `node --test`): node records to pruned, paged tree; ref keys; control class
    (risk); deny list; token estimate (characters / 3, as AA 13.8).
  - `src/app/assistant/ui-control.js` (DOM): walks the DOM, builds node records, resolves refs, dispatches actions, reads
    back.
  - `src/app/commands/ui.mjs`: the two command definitions.
  - `main.js` `DEFAULT_SETTINGS.assistant.uiControl = false`; `SettingsDialog.jsx` switch "Let the assistant press buttons".
  - `data-agent-exclude` on excluded roots; optional `data-command="<id>"` on controls whose action has a command;
    optional `data-agent-risk="destructive|approval"` on controls the label rules miss.

### 4.2 `ui.snapshot`

`ui.snapshot {area?, cursor?, maxTokens?: 500..6000 = 2500, marks?: false}` (read, `headless:false`, gates `ui.control`,
`window.visible`) returns:

```
{snap, page, rect, nextCursor?, truncated?,
 nodes: [{ref, role, name, state?, value?, bounds:[x,y,w,h], area, depth, cmd?, risk?}],
 marks?: {png, width, height}}
```

- Walk: from `document.body`, the visible, non-inert elements that are interactive (native `button`, `a[href]`, `input`,
  `select`, `textarea`, `[role]` in button, link, checkbox, switch, radio, tab, menuitem, menuitemcheckbox,
  menuitemradio, option, combobox, slider, spinbutton, treeitem, `[tabindex="0"]`) plus landmark and group parents that
  carry a name (`[role=region|toolbar|menu|listbox|tablist|dialog]`, `aside`, `nav`, `header`) so the tree has structure.
  Elements under `inert` (the hidden editor page, `EditorPage.jsx:12`) and with `display:none`, `visibility:hidden` or zero
  size are skipped.
- `name`: `aria-label`, then `aria-labelledby` text, then the Radix Tooltip text of the trigger (`Tip.jsx`), then visible
  text (60 chars), then `title`. The renderer already has 189 `aria-label`s; controls without a name are listed with
  `name: ''` and counted in `unnamed` so they can be fixed.
- `state`: `pressed` (`aria-pressed`, `data-state=on`), `checked`, `selected`, `expanded`, `disabled`, `current`.
  `value`: inputs, sliders, selects (60 chars). Never the value of an excluded field.
- `area`: from the nearest known root: `titlebar` (`[data-titlebar]`), `sidebar`, `toolbar`, `rail` (`[data-board-chrome]`),
  `ribbon`, `canvas-bar` (`[data-bar]`), `status`, `page` (`#editor-area`, `#workspace-root`), `menu` (Radix portal with
  `role=menu|listbox`), `notices`.
- `bounds`: `getBoundingClientRect()` rounded to CSS px, window coordinates. Used for marks and readback only; the model
  never sends coordinates.
- `ref`: short id `e1..eN` per snap. Each ref also stores a key = hash of `(area, role, name, data-command, ordinal among
  equal siblings)`. `ui.invoke` resolves by ref first; if the element is gone it retries by key once; else `stale`.
- `snap`: id plus `Date.now()`. A snap older than 30 s or after a view change -> `stale`.
- Pruning to fit 16K context: depth capped at 6; containers with one child collapse; named groups only; decorative nodes
  (`aria-hidden`, svg) dropped; repeated rows (draft list, ticket rows, tool tiles) beyond 20 per parent become one node
  `{role:'more', name:'48 more drafts', area}` that `area` + `cursor` can page into. Over `maxTokens`, the walk pages by
  area in this order: open menu, page, toolbar, rail, ribbon, sidebar, status; `nextCursor` = `{snap, area, offset}`.
  Default 2500 tokens leaves room for the system prompt, tools and history in 16K.
- Excluded (never listed, never invokable):
  - password fields (`input[type=password]`, `autocomplete` containing `password`), even if none exist today;
  - the assistant itself: `#assistant-panel`, `[data-chat-island]`;
  - the approval card (`AgentAsk`), the Settings dialog, install dialogs, every open `role=dialog` and `role=alertdialog`
    (`DialogHost`, confirm dialogs from `removeFlow`, `removePrefab`, `deletePlan`), so the user's confirmations still
    apply;
  - the title bar and window controls;
  - the editor's contenteditable (`.ProseMirror`) and board surfaces (canvas elements): text and items go through `doc.*`
    and `board.*`;
  - the dictation mic button and the status bar agents popover with Disconnect;
  - the forum window and OS dialogs (file pickers, save dialogs): they are not in this renderer's DOM, so they cannot be
    reached; the design states it so no one adds a bridge.
- Marks (`marks: true`, AA 13.10): main `webContents.capturePage()` of the window, minus the assistant panel rect (painted
  over grey before encoding), scaled to 1280 max side; the renderer draws a numbered badge at the top-left of each listed
  node's `bounds` (the number is the ref's digits). Sent as an image part only when the model has vision (Qwen3.5-4B with
  the mmproj); otherwise omitted. Reuse the badge drawer planned for `view.render`.

### 4.3 `ui.invoke`

`ui.invoke {snap, ref, action:'click'|'type'|'select'|'key', value?, key?}` (write, `headless:false`, gates `ui.control`,
`window.visible`, `dialog.none`) returns `{name, role, action, before, after, opened:'menu'|'dialog'|null, notice?,
command?, missingCommand}`.

- One ref per call. Refused inside `batch` (`steps[i]: ui.invoke runs alone`).
- `click`: if the element has `data-command`, run that command through `invoke` with this call's source, so its gates,
  risk, asks and undo apply; else `focus()`, then `pointerdown`, `pointerup` (PointerEvent, `button:0`,
  `pointerType:'mouse'`, as Radix triggers need), `click`.
- `type`: only on `input` (text, number, search, url) and `textarea` that are not excluded. Sets the value through the
  native value setter and fires `input` then `change`, so React sees it. `value` max 2000 chars. Never on contenteditable.
- `select`: native `select` -> set `value` + `change`. Radix Select or combobox -> open the trigger, find the
  `[role=option]` whose name equals `value` in the portal, click it; `not_found` with the option names if none matches.
- `key`: allowlist `Enter`, `Escape`, `Tab`, `Space`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Home`, `End`,
  dispatched as `keydown` / `keyup` on the ref element only (menus, sliders, tabs). No modifiers, so no shortcuts (Ctrl+Z,
  Delete) can be sent.
- Readback: after two animation frames, re-read the element (state, value, name), detect a new menu or dialog portal, and
  read a new notice or toast. `before` / `after` are the node's `{state, value}`. If the element is gone, `after: null`.
- Safety:
  - Control class from `ui-tree.mjs`: `data-agent-risk` first, then label rules: `/delete|remove|trash|discard|clear all/i`
    -> destructive; `/push|post|send|log ?in|sign ?in|unpush|install|download/i` -> approval. A destructive or approval
    control raises the approval card (`ctx.ask` with that risk and the text `Press "<name>" in <area>`) before any event.
    Data-command controls use their command's risk instead.
  - Deny list (refused `denied{policy}`, never asked): everything in the exclusion list above, plus Settings opener,
    "Allow local AI agents", agent Disconnect, assistant install/delete, server path fields. Kept as one array in
    `ui-tree.mjs` next to the label rules, tested.
  - Gates: `ui.control` (off by default), `window.visible`, `dialog.none` (a click outside an open modal would close it or
    race its save).
  - Audit line for every call: `{id:'ui.invoke', ref, key, name, role, area, action, valueLength, command?, result}`. The
    typed value itself is not audited.
  - Step line in the transcript: `Pressed "Bold" (toolbar)`, `Typed 12 characters into "Width" (canvas bar)`. Undo on the
    step line only when a `data-command` with `undo: 'doc'` ran.
  - Stop: the loop's abort signal is checked before resolving the ref and before each dispatched event; Stop cancels a
    pending approval ask. `cancelled` comes back and nothing is dispatched after it.
- `missingCommand: true` when no `data-command` ran; the audit tail and `app.capabilities` list the top missing labels.

### 4.4 Build steps

1. Gates: add `window.visible`, `ui.control`, `dialog.none` to `gates.mjs`; `settings` subject in `subjectOf`. Change the
   headless check in `commands.js:289, :351` to the `window.visible` gate for `agent:assistant`.
2. Setting: `assistant.uiControl: false` in `main.js` defaults, the switch in `SettingsDialog.jsx`, readable through
   `settings.get`, not patchable (the agent must not turn it on).
3. Markers: `data-agent-exclude` on `#assistant-panel`, `[data-chat-island]`, `AgentAsk`, `SettingsDialog`,
   `DialogHost` content, `TitleBar`, the dictation mic, the agents popover; `data-agent-risk` where label rules miss
   (icon-only delete buttons with a tooltip still match by name).
4. `ui-tree.mjs`: `pruneTree(records, {maxTokens, area, cursor})`, `refKey(record)`, `classify(record)`, `DENY`,
   `estimateTokens`.
5. `ui-control.js`: `readRecords(root)`, `resolve(snap, ref)`, `dispatch(el, action, opts, signal)`, `readBack(el)`.
6. Commands in `ui.mjs`; add both ids to `CORE` only while the setting is on (filter in `loop.js` tool list); otherwise
   `commands.describe` returns them with the gate's fix text.
7. Marks: reuse `capturePage` in main (new IPC `window.capture {rect?}`, `preload.js`), badge drawer shared with
   `view.render`.
8. System prompt line: registry first, fallback second, one ref per call, re-snapshot after a menu opens.
9. `data-command` on toolbar and rail buttons as their commands land (C4 wave by wave).

### 4.5 Tests

Lean, per the project rule: one unit file and one harness run.
- `test/ui-tree.test.mjs` (`node --test`): pruning keeps a 300-node fixture under 2500 tokens; paging returns every node
  once across cursors; ref keys stay equal across two snapshots of the same fixture; excluded and password records never
  appear; label rules classify "Delete plan" destructive, "Push to forum" approval, "Bold" write; deny list refuses
  "Allow local AI agents".
- Harness script `test/smoke/ui-control.json` (run with `--script`, `window.__agent.script`): setting off -> `ui.snapshot`
  denied with the gate fix; setting on -> snapshot lists the toolbar "Bold" button; select text with `ui.select`, invoke
  "Bold", read back `pressed: true`; invoke a draft "Delete" -> the ask appears (script answers deny) and the draft stays;
  open a confirm dialog -> `ui.invoke` refused by `dialog.none`; type into the canvas bar width input -> value reads back;
  a ref after a view change -> `stale`.

## 5. What the assistant must not reach

| Item | Reason |
|---|---|
| Approval card Allow / Deny | Approval is a user click only (AA 13.4, 11 #8) |
| "Allow local AI agents" switch, Settings > Assistant permissions and "Let the assistant use on-screen controls" (`settings.assistant.permission`, `uiControl`) | An agent must not grant itself or others access |
| Agents popover Disconnect | The user's control over access |
| Push-to-talk mic | The mic opens only while the user holds it |
| Dictation / assistant server program, model file, projector, server URL | Runs arbitrary executables or sends drafts and audio off-machine (AA 13.6) |
| Assistant model, backend, install, delete, idle unload | Would restart or kill its own runtime mid-turn; multi-GB downloads |
| Chat panel controls (New chat, Stop, Think, panel position) | Its own chrome; it could cancel or clear its own conversation |
| Password fields, forum login credentials | The user types credentials in the forum window; `forum.login` only opens it, with approval |
| Forum window contents, OS file and save dialogs | Outside the renderer; whole-file plan import/export and image pickers stay user-only |
| Open ticket links in the system browser | Arbitrary external URLs |
| Board clipboard cut / copy / paste | The clipboard is the user's; moves use `board.get` + `board.items.*` |
| `history.undo/redo`, `plan.undo/redo`, `flow.undo/redo` in view sets | The stacks hold the user's own edits; step-line Undo reverts the assistant's own step |
| Hidden settings (lastDraftId, lastView, planTab, draft maps) | User state written by drafts.* and plan.open paths only |
| Open Settings dialog, title bar, window chrome | Each setting has its own command; chrome has no data |
| `board.render`, `plan.render` in text-model tool sets | PNG as base64 text; offer after the vision phase |

## 6. Build order for C4 part 2

Each wave ends with `node --test` and one harness run (lean verification).

1. Wave 1, application control and its prerequisites: gates `window.visible`, `ui.control`, `dialog.none`; headless rule
   change; `assistant.uiControl` setting; exclusion markers; `ui-tree.mjs`, `ui-control.js`, `ui.snapshot`, `ui.invoke`;
   marks via `capturePage`; `test/ui-tree.test.mjs`, `test/smoke/ui-control.json`. After this wave every visible control is
   reachable, with approvals.
2. Wave 2, unblock what exists: `tool.run` out of `NEVER` with Undo/Redo refused inside; dialog-opening palette entries
   `headless:false`; `ui.state` extension; `ui.view`; `ui.select` text range and deselect; delete-row/column asks;
   synced-write wording.
3. Wave 3, plans: `plan.mjs` registering every descriptor; `plan` subject and the two PLAN_GATES in `gates.mjs`;
   `plan.exists`; `plan.ui.set`, `plan.select`; `VIEW_SETS.plan`; step-line Undo check for the shared plan stack.
   Exit: `test/smoke/plan-basic.json`.
4. Wave 4, flowcharts: `{flowId}` addressing on `board.*`; `flow.mjs` with `flow.library.*`, `flow.insert`, `flow.import`,
   `flow.link`, `flow.unlink`, `flow.export`, `flow.layout`, `flow.graph.get`; `ui.zoom` / `ui.select` on the library board;
   `VIEW_SETS.flows`. Exit: `flow-agent.json`, `flow-library.json`.
5. Wave 5, board ergonomics: `board.read`, `board.query` (AA 13.8), `board.items.align`, `board.items.duplicate`,
   `board.fit`, `board.tools.set`, `board.snap.set`, `doc.setBlockType`, `doc.clearFormat`, `doc.table`, `drafts.save`,
   `dictation.state`.
6. Wave 6, prefabs and the rest: `flow.prefabs.*`, `flow.favourites.*`, `flow.shapes.*` (exit `flow-prefab.json`); P3 ids
   (`board.items.style`, `cloneConnect`, `reset`, `folders.move/update`, `ui.windowZoom`, `dictation.settings/install`,
   `assistant.status`, `presets.*` after a user decision); `data-command` on every control whose command now exists.
