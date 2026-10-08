# DAF Writer — Gantt + Kanban plan workspace

Status: plan, final draft for implementation. Planning only; no code was changed. Paths are relative to `A:/Programming Dumpster/DAF Writer/`; line numbers are from the code read on 2026-10-05 (references added on 2026-10-06 re-checked that day) and SPEC.md wins where they drift. Revised on 2026-10-06 with the user's decisions (per-plan columns, estimate units, agent deletes always ask; later that day: a confirm that creates a matching tag when a linked card is dropped on a column that follows no tag, and per-entry commands instead of whole-list setters; later still: per-entry commands for a ticket's dependencies, labels, checklist and links, precise edits and preconditions shared with the UI (agent-automation.md §4.3 #11, §3.7), and a **Plans** tab at the bottom of the left sidebar plus a plan-chart button in the bottom toolbar as the entry points) and a verified library survey (§9). The sibling automation-layer plan (`docs/plans/agent-automation.md`: `define()` command registry, `invoke`, agent asks, MCP bridge) has **not** landed: Phases 0–3 below are self-contained and need nothing from it; Phase 4 wires this feature into it and is the only phase that depends on it (its Phases 0–2; its Phase 3 for the `daf-agent` check). Later on 2026-10-06: the order of work with the flowchart plan is `docs/plans/roadmap.md` (this plan's phases are its stages A1–A4 and part of C4; its Stage 1 builds the shell both plans share: `fileFamily`, the view switch, the sidebar footer with both tabs, the two toolbar insert buttons, `gates.mjs`), and the §12 questions take their stated defaults (user decision).

## 1. Goal and scope

One **plan per forum thread**, stored locally as `userData/plans/<uuid>.json`. A plan holds its own status columns (up to 10), estimate units, and tickets (backlog items) with status, priority, labels, estimate, dates, dependencies, milestones, parents, checklists, links to drafts and forum posts, and saved views. Three views over the same records live in a **plan workspace** that covers the main column while open (the editor stays mounted): **Board** (Kanban, columns per plan, seeded from the three default draft status tags and mapped to global tags for draft cards), **Backlog** (table), **Gantt** (bars, dependency lines, critical path, baseline). A **`planChart` document node** embeds any view in a post with its own options (which view, columns, filters, fields, range, zoom, size), renders live from the plan or from a frozen snapshot, and exports to PNG on push like boards. Every mutation is one pure reducer call behind one `dispatch(commandId, args)` function that the UI, Ctrl+Space and (Phase 4) AI agents share, and each command is a precise edit: it changes one entry or one field set and never rewrites a whole plan or list (agent-automation.md §4.3 #11).

In scope: single user, one plan per thread, tickets ≤ a few hundred per plan. Out of scope (§13): assignees, comments, time tracking, resource levelling, recurring tasks, notifications, multiple calendars.

Hard constraints kept: CSP unchanged (no CDN, no web fonts), JavaScript only, shadcn via CLI only, renderer sandboxed (all disk access through `window.api`), push never submits, drafts/settings formats unchanged except the additive keys in §3.4.

## 2. User stories

1. From the **Plans** tab at the bottom of the sidebar (or from a thread row) I open the thread's plan board; the first time it is created after a confirm.
2. I add tickets quickly (type a title, Enter, next), drag cards between status columns, open a card and fill in dates, labels, estimate, checklist.
3. My drafts for that thread appear as cards in the column mapped to their status tag, untagged ones (or ones whose tag no column maps) in a "No status" column; dragging a draft card onto a mapped column changes its tag exactly as the sidebar Tag menu does; onto a column that follows no tag, a popup offers to create a matching tag or cancel the drop.
4. Each plan starts with To do / In progress / Done; I add columns (up to 10), rename, recolour, reorder and delete them, and choose which global status tag each column follows.
5. I estimate in working days by default, or in my own units (points, hours) that each declare how many days one unit is; sums and the Gantt use days.
6. I convert a draft card into a ticket (or link a ticket to a draft) and the two show one status from then on.
7. I see which tickets are blocked by unfinished predecessors and which are ready to start.
8. In the Gantt I drag bars to move or resize them in whole working days, draw dependency arrows from one bar to another, see the critical path and whether a start date violates a dependency.
9. I insert the board or the Gantt into a draft (a button in the bottom toolbar), choose what it shows (columns, labels, date range, fields), resize it, and on push it arrives in the forum as a PNG at exactly that width. I can freeze it so the post keeps that moment.
10. Ctrl+Z in the workspace undoes my last plan change, including a draft card move.
11. I can type "gantt" or "new ticket" in Ctrl+Space and get there.
12. Later, an AI agent can create a plan from a work breakdown, read the schedule back as Markdown or Mermaid, move tickets, insert a chart into my draft and render it to an image to check it — through the same commands, with the same validation, never writing files itself; every delete it attempts asks me first, every time.

## 3. Concepts and data model

### 3.1 Concepts and invariants

| Concept | Definition |
|---|---|
| Plan | One record per thread, `threadUrl` normalised (query/hash stripped, as `addThreadUrl` actions.js:472) and matching `TOPIC_URL_RE` (main.js:11). One plan per thread: the renderer picks the newest when two exist and toasts; `plan.create` refuses a second. |
| Column | `plan.columns` = `[{id, name, color, tagId, wip}]` in board order, 1–10 entries, owned by the plan (user decision). `newPlan` seeds three columns from `DEFAULT_TAGS` (drafts-meta.js:5-9): ids `todo`, `progress`, `done`, the same names and colours, `tagId` = the same id when `tagList(settings)` (drafts-meta.js:12) contains it, else `null`. Later columns get `newId()` ids. Renaming or recolouring a global tag never changes a column, and vice versa. `wip` = advisory limit (integer ≥ 1) or null. |
| Status | A column id of the plan, or `null` = "No status". The Board shows `plan.columns` in order, preceded by a "No status" column shown only when non-empty (or when a chart's `columns` lists `null`). |
| Tag ↔ column map | `column.tagId` names one global tag (`settings.tags` id); at most one column per tag (`tag_taken`). **The draft's global tag is the owner; the column is derived from it.** Read (tag → column): `columnForTag(ctx, tagId)` = the column whose `tagId` equals the tag, when that tag still exists in `ctx.tags`; no such column, or no tag → `null` ("No status", with a muted badge naming the unmapped tag). Write (column → tag): moving a linked ticket or draft card onto a column with `tagId` writes that tag (`tagDraft`, drafts-meta.js:30); onto "No status" clears it (`null`, as the sidebar Tag menu's "No tag", Sidebar.jsx:243); onto a column with `tagId: null` **asks first** (user decision): `confirmDialog` (actions.js:46-49) "Create a matching tag 'Review'?" with **Create** / Cancel. Create adds the global tag `{id: crypto.randomUUID(), name: column.name, color: column.color}` at the end of `settings.tags` (as the Settings tag manager's Add tag, SettingsDialog.jsx:183; no tag limit exists), sets the column's `tagId` to it (replacing a stale `tagId` of a missing tag), then completes the move and tags the draft(s): one dispatch, one undo entry. When a global tag with the column's name (trimmed, case-insensitive) exists and no column of this plan maps it, that tag is used instead of a duplicate ("Use the tag 'Review' for this column?", **Use tag** / Cancel). Cancel aborts the whole drop: the card snaps back, nothing is written, no undo entry. Agents get no popup: `plan.tickets.move` is refused with `unmapped_column` unless the call passes `createTag: true` (§8.3). The case is rare (user's note): a draft carries only tags that exist, so it takes a column that follows none. A `tagId` whose tag is missing from settings is kept in the file and read as unmapped; only an explicit delete in the Settings tag manager clears it (`unmapTag`, §4). |
| Done | `plan.doneColumn`: the column id that counts as done; seeded `done`. Missing/unknown → the last column. Progress reads 100 in done; `ready`/`blocked`, `hideDone`, `completedAt` all use it. |
| Linked ticket | A ticket with `draftId`. **Its status is derived at read time**: `columnForTag(ctx, draftTag(settings, draftId)?.id)`. Its stored `status` is ignored while linked; moving it changes `settings.draftTags` only, by the write rule above (one owner: `settings.draftTags`). Linking: when the ticket's column has a `tagId`, that tag is written onto the draft (`tagDraft`) and the ticket stays put; when the column is unmapped (or "No status"), the draft keeps its tag and the ticket shows in the column derived from it (toast "Moved to <column>: linked drafts follow their status tag"). Unlinking (dialog, or the draft is gone) copies the last derived column into `ticket.status`. The draft's own card is hidden while a ticket links it. |
| Draft card | A draft of the thread with no linking ticket, shown when `options.showDrafts`. Kind `draft`; its column is `columnForTag` of its tag; it has no ticket fields. "Convert to ticket" creates a ticket `{title: draft.title, status: that column, draftId}`. |
| Estimate | `ticket.estimate` (number ≥ 0 or null) in `ticket.unit`. Units: the built-in `d` (one working day, never stored, not removable) plus `plan.units = [{id, name, daysPer}]`, where every custom unit must declare `daysPer > 0` (user decision: e.g. `pt` with `daysPer 0.5`). `plan.estimateUnit` = the default unit for new tickets (`d` unless changed). `estimateDays(plan, ticket) = estimate × daysPer` (`d` → 1); sums, parent summaries, progress weights and the Gantt use days only. Units never convert to each other except through days. |
| Order | `plan.order` = every ticket id once. Board column order, Backlog order and Gantt row order all read it (`sortDrafts`/`moveBeside`, draft-order.mjs:5-16, generic over `{id}`). Missing ids sort first; stale ids are dropped on save. |
| Tree | `parent` points at another ticket; any depth; cycles refused. Rows render as a tree (roots in `order`, children in `order` under their parent). A parent with children ignores its own `start/end/progress/estimate` (derived summary); dependencies on or from a parent with children are refused (`parent_dep`). Swimlane "parent" uses the top-level ancestor. |
| Dates | `YYYY-MM-DD` strings; all math in working-day indexes (§3.7). `created`, `updated`, `completedAt`, `baselineAt`, `frozen.at` are ms-epoch numbers set by the renderer except `created/updated`, which main stamps on write (like `saveDraft` main.js:133-148). |
| Dependency | `{on, type, lag}` stored on the successor; `type ∈ FS, SS, FF, SF`; `lag` integer working days (negative = lead). "Blocked" = any predecessor not done. One concept serves Gantt links and Kanban blocking. |
| Ticket key | `num` = per-plan counter (`plan.seq`), shown as `#12`; stable, never reused. Commands accept `#12` or the uuid. |
| Ids | Plan and ticket ids uuid v4 (`crypto.randomUUID()`, validated by `DRAFT_ID_RE` main.js:12 before any path). Label, column (except the seeded `todo`/`progress`/`done`), unit, checklist, link (`urls[]`), view and chart-node ids: 7-char base36 like `newId()` (whiteboard.js:45), unique within their plan / node; the unit id `d` is reserved. Never address by index or title in stored data. |
| Validation | `parsePlan(json, ctx)` never throws: it fills defaults, drops invalid parts (dangling deps, unknown label ids, bad dates), sets a status that names no column to `null` (columns live in the same file, so an unknown id only comes from a hand edit or import). Reducers return the input unchanged plus `error` on refusal. |

### 3.2 Plan file `userData/plans/<planId>.json`

```json
{
  "version": 1,
  "id": "3f1c2a9e-4b7d-4f1e-9c2a-7d5e1f0b8a21",
  "threadUrl": "https://daf.staffs.ac.uk/topic/88136-level-design-dev-thread/",
  "title": "Level design dev thread",
  "seq": 7,
  "calendar": { "workdays": [1, 2, 3, 4, 5], "holidays": ["2026-12-25"], "weekOne": "2026-09-21" },
  "columns": [
    { "id": "todo", "name": "To do", "color": "#e5e5e5", "tagId": "todo", "wip": null },
    { "id": "progress", "name": "In progress", "color": "#3d99f5", "tagId": "progress", "wip": 3 },
    { "id": "r7k2m9q", "name": "Review", "color": "#e09952", "tagId": null, "wip": null },
    { "id": "done", "name": "Done", "color": "#62d926", "tagId": "done", "wip": null }
  ],
  "doneColumn": "done",
  "units": [{ "id": "p4t8x2q", "name": "pt", "daysPer": 0.5 }],
  "estimateUnit": "d",
  "autoSchedule": false,
  "labels": [{ "id": "a1b2c3d", "name": "Art", "color": "#e09952" }],
  "views": [{ "id": "v1x9k2m", "name": "This sprint", "view": "kanban", "options": { "labels": ["a1b2c3d"], "hideDone": true } }],
  "order": ["6f0e…", "9a3b…"],
  "tickets": [{
    "id": "6f0e8c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b",
    "num": 3,
    "title": "Blockout level 1",
    "description": "",
    "status": "progress",
    "priority": 2,
    "labels": ["a1b2c3d"],
    "estimate": 3,
    "unit": "d",
    "start": "2026-10-08",
    "end": "2026-10-13",
    "milestone": false,
    "progress": 40,
    "parent": null,
    "deps": [{ "on": "9a3b…", "type": "FS", "lag": 0 }],
    "checklist": [{ "id": "k1q8z3v", "text": "Greybox", "done": true }],
    "draftId": "0b2c7d1e-5f6a-4b8c-9d0e-1f2a3b4c5d6e",
    "urls": [{ "id": "u3n8c5w", "url": "https://daf.staffs.ac.uk/topic/88136-x/#findComment-123", "title": "Feedback post" }],
    "baseline": { "start": "2026-10-06", "end": "2026-10-10" },
    "completedAt": null,
    "created": 1759600000000,
    "updated": 1759600000000
  }],
  "baselineAt": 1759600000000,
  "created": 1759600000000,
  "updated": 1759600000000
}
```

JSON Schema (only keywords the automation layer's `schema.mjs` supports, agent-automation.md §8: `type`, `properties`, `required`, `additionalProperties`, `enum`, `const`, `default`, `pattern`, `items`, `minItems`, `maxItems`, `maxLength`, `minimum`, `maximum`, `$ref`):

```json
{
  "$defs": {
    "ID":   { "type": "string", "pattern": "^[a-f0-9-]{36}$" },
    "SID":  { "type": "string", "pattern": "^[a-z0-9]{7}$" },
    "DATE": { "type": ["string", "null"], "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
    "COLOR": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
    "CID":  { "type": "string", "pattern": "^[a-z0-9]{1,16}$" },
    "Column": { "type": "object", "required": ["id", "name", "color"], "additionalProperties": false,
      "properties": { "id": { "$ref": "#/$defs/CID" }, "name": { "type": "string", "maxLength": 40 }, "color": { "$ref": "#/$defs/COLOR" },
        "tagId": { "type": ["string", "null"], "maxLength": 64 }, "wip": { "type": ["integer", "null"], "minimum": 1 } } },
    "Unit": { "type": "object", "required": ["id", "name", "daysPer"], "additionalProperties": false,
      "properties": { "id": { "$ref": "#/$defs/SID" }, "name": { "type": "string", "maxLength": 12 }, "daysPer": { "type": "number", "minimum": 0.001 } } },
    "Dep": { "type": "object", "required": ["on"], "additionalProperties": false,
      "properties": { "on": { "$ref": "#/$defs/ID" }, "type": { "enum": ["FS", "SS", "FF", "SF"], "default": "FS" }, "lag": { "type": "integer", "default": 0 } } },
    "Label": { "type": "object", "required": ["id", "name", "color"], "properties": { "id": { "$ref": "#/$defs/SID" }, "name": { "type": "string", "maxLength": 40 }, "color": { "$ref": "#/$defs/COLOR" } } },
    "Check": { "type": "object", "required": ["id", "text"], "properties": { "id": { "$ref": "#/$defs/SID" }, "text": { "type": "string", "maxLength": 200 }, "done": { "type": "boolean", "default": false } } },
    "Url":   { "type": "object", "required": ["id", "url"], "properties": { "id": { "$ref": "#/$defs/SID" }, "url": { "type": "string", "pattern": "^https?://" }, "title": { "type": "string", "maxLength": 80 } } },
    "View":  { "type": "object", "required": ["id", "name", "view"], "properties": { "id": { "$ref": "#/$defs/SID" }, "name": { "type": "string", "maxLength": 40 }, "view": { "enum": ["kanban", "backlog", "gantt"] }, "options": { "$ref": "#/$defs/Options" } } },
    "Ticket": { "type": "object", "required": ["id", "num", "title"], "additionalProperties": false,
      "properties": {
        "id": { "$ref": "#/$defs/ID" }, "num": { "type": "integer", "minimum": 1 },
        "title": { "type": "string", "maxLength": 200 }, "description": { "type": "string", "maxLength": 20000 },
        "status": { "type": ["string", "null"], "pattern": "^[a-z0-9]{1,16}$" }, "priority": { "type": "integer", "minimum": 0, "maximum": 4 },
        "labels": { "type": "array", "items": { "$ref": "#/$defs/SID" } },
        "estimate": { "type": ["number", "null"], "minimum": 0 }, "unit": { "type": "string", "pattern": "^(d|[a-z0-9]{7})$" },
        "start": { "$ref": "#/$defs/DATE" }, "end": { "$ref": "#/$defs/DATE" }, "milestone": { "type": "boolean" },
        "progress": { "type": "integer", "minimum": 0, "maximum": 100 },
        "parent": { "type": ["string", "null"], "pattern": "^[a-f0-9-]{36}$" },
        "deps": { "type": "array", "items": { "$ref": "#/$defs/Dep" } },
        "checklist": { "type": "array", "items": { "$ref": "#/$defs/Check" } },
        "draftId": { "type": ["string", "null"], "pattern": "^[a-f0-9-]{36}$" },
        "urls": { "type": "array", "items": { "$ref": "#/$defs/Url" } },
        "baseline": { "type": ["object", "null"], "properties": { "start": { "$ref": "#/$defs/DATE" }, "end": { "$ref": "#/$defs/DATE" } } },
        "completedAt": { "type": ["integer", "null"] }, "created": { "type": "integer" }, "updated": { "type": "integer" } } },
    "Options": { "type": "object", "additionalProperties": false,
      "properties": {
        "title": { "type": ["string", "null"] },
        "columns": { "type": ["array", "null"], "items": { "type": ["string", "null"] } },
        "labels": { "type": ["array", "null"], "items": { "$ref": "#/$defs/SID" } },
        "priority": { "type": ["array", "null"], "items": { "type": "integer", "minimum": 0, "maximum": 4 } },
        "hideDone": { "type": "boolean" }, "doneWithinDays": { "type": ["integer", "null"], "minimum": 1 },
        "search": { "type": "string", "maxLength": 100 },
        "swimlane": { "enum": [null, "label", "parent", "priority"] },
        "showDrafts": { "type": "boolean" }, "unpushedOnly": { "type": "boolean" },
        "fields": { "type": "array", "items": { "enum": ["num", "labels", "due", "checklist", "priority", "estimate", "progress", "draft", "pushed", "blocked", "deps"] } },
        "range": { "type": ["object", "null"], "properties": { "start": { "$ref": "#/$defs/DATE" }, "end": { "$ref": "#/$defs/DATE" } } },
        "zoom": { "enum": ["day", "week", "month", "quarter", "fit"] },
        "weekLabels": { "enum": ["date", "number"] },
        "showDeps": { "type": "boolean" }, "showCritical": { "type": "boolean" }, "showBaseline": { "type": "boolean" },
        "showToday": { "type": "boolean" }, "showTaskList": { "type": "boolean" }, "showWeekends": { "type": "boolean" },
        "legend": { "type": "boolean" }, "footer": { "type": "boolean" } } }
  },
  "type": "object", "required": ["version", "id", "threadUrl", "tickets", "order"],
  "properties": {
    "version": { "const": 1 }, "id": { "$ref": "#/$defs/ID" },
    "threadUrl": { "type": "string", "pattern": "^https://daf\\.staffs\\.ac\\.uk/topic/\\d+[^\\s?#]*$" },
    "title": { "type": "string", "maxLength": 120 }, "seq": { "type": "integer", "minimum": 0 },
    "calendar": { "type": "object", "properties": {
      "workdays": { "type": "array", "items": { "type": "integer", "minimum": 0, "maximum": 6 }, "minItems": 1 },
      "holidays": { "type": "array", "items": { "$ref": "#/$defs/DATE" } },
      "weekOne": { "$ref": "#/$defs/DATE" } } },
    "columns": { "type": "array", "items": { "$ref": "#/$defs/Column" }, "minItems": 1, "maxItems": 10 },
    "doneColumn": { "$ref": "#/$defs/CID" },
    "units": { "type": "array", "items": { "$ref": "#/$defs/Unit" } },
    "estimateUnit": { "type": "string", "pattern": "^(d|[a-z0-9]{7})$" }, "autoSchedule": { "type": "boolean" },
    "labels": { "type": "array", "items": { "$ref": "#/$defs/Label" } },
    "views": { "type": "array", "items": { "$ref": "#/$defs/View" } },
    "order": { "type": "array", "items": { "$ref": "#/$defs/ID" } },
    "tickets": { "type": "array", "items": { "$ref": "#/$defs/Ticket" } },
    "baselineAt": { "type": ["integer", "null"] }, "created": { "type": "integer" }, "updated": { "type": "integer" } }
}
```

Defaults (`parsePlan` fills them): `title` = the thread's `threadLabel` at creation; `seq 0`; `calendar {workdays [1..5], holidays [], weekOne null}`; `columns` = the three seeded columns (§3.1; also when the key is missing or yields no valid column); `doneColumn 'done'`; `units []`; `estimateUnit 'd'`; `autoSchedule false`; `labels []`; `views []`; column: `tagId null`, `wip null`; ticket: `description ''`, `status` = first column id, `priority 0` (0 none, 1 urgent, 2 high, 3 medium, 4 low), `labels []`, `estimate null`, `unit` = `plan.estimateUnit`, `start/end null`, `milestone false`, `progress 0`, `parent null`, `deps []`, `checklist []`, `draftId null`, `urls []`, `baseline null`, `completedAt null`.

Rules beyond the schema (enforced by `parsePlan` and the reducers):
- `start` and `end` are both set or both null; `end ≥ start`; a milestone has `start === end`. Stored dates are normalised on every write: start → the next working day, end → the previous working day, then `end < start → end = start`.
- `deps`: no self-dep, no dep on a missing ticket (dropped on load), no cycle (refused), none on or from a parent with children (refused `parent_dep`).
- `labels` of a ticket ⊆ `plan.labels` ids (unknown dropped).
- `columns`: 1–10 entries (extra ones beyond the 10th dropped on load; `plan.columns.add` needs the gate `plan.columnRoom`, §8.2); ids unique; names trimmed, empty → `Column n`; a `tagId` already taken by an earlier column is cleared on load and refused (`tag_taken`) by the reducers. Deleting the last column is gated (`plan.otherColumn`). `doneColumn` not in `columns` → the last column.
- `calendar.holidays`: sorted, unique; they change one date per command (`plan.holidays.add` / `.remove`, §8.3); `workdays` and `weekOne` are fields of `plan.update`.
- Deleting a column (`removeColumn(ctx, id, moveTo)`): unlinked tickets in it get `status = moveTo` (default the left neighbour, else the right one; `null` = "No status" allowed); linked tickets and draft cards keep their global tag (no settings write) and therefore show in "No status" (the deleted column was the one mapping their tag) until another column maps it; a deleted `doneColumn` falls back to the last remaining column; saved views and chart options that list the id ignore it (dropped on their next save).
- `units`: `daysPer` finite and > 0 (invalid units dropped on load); names trimmed, non-empty, unique case-insensitively, never `d` (`addUnit` / `updateUnit` refuse a breach with `bad_unit`). A ticket or `estimateUnit` naming an unknown unit falls back to `d` (number kept). Removing a unit (`removeUnit`) converts every ticket estimate in it to days (`estimate × daysPer`, unit `d`), so removal never changes the scheduled meaning; a removed `estimateUnit` falls back to `d`.
- `draftId` of a draft that no longer exists → unlinked on the next save (`pruneDrafts`), copying the last derived status into `status`.
- `order` contains every ticket id exactly once after `parsePlan` (missing prepended in file order, stale dropped).
- `urls[]`: a link without an `id` (a hand edit or an import) gets a `newId()` on load. `url`: `https?://` only; a `FORUM_URL_RE` url opens in the forum window (`api.forum.open`), others through `window.open` → `setWindowOpenHandler` → `shell.openExternal` (main.js:423-426).
- `completedAt`: set when the derived status becomes done, cleared when it leaves done (`syncCompleted`, run after every dispatch and on `settings.draftTags` change).
- `baseline`: set per ticket by Set baseline (copies `start/end` of every scheduled ticket; `baselineAt = now`); Clear baseline nulls both.
- Derived, never stored: duration, ES/EF/LS/LF, float, critical, conflict, blocked, ready, WIP counts, parent summaries, overdue, derived status of linked tickets and draft cards, estimates in days.

### 3.3 Context the model reads

Every selector and reducer that needs settings or drafts takes one `ctx` built by `planContext(planId)` in `src/app/plans.js`:

```js
ctx = {
  plan,                       // the parsed plan
  tags,                       // tagList(settings): needed by columnForTag (done = plan.doneColumn, no settings key)
  drafts,                     // state.drafts filtered to plan.threadUrl: [{id, title, threadUrl, updated, pushedAt}]
  draftTags,                  // settings.draftTags ?? {}
  today,                      // 'YYYY-MM-DD' local date
}
```

`plan-model.mjs` imports `drafts-meta.js` (import-free, Node-tested) for `draftTag`-equivalent lookups; it has no other imports.

### 3.4 Settings additions (shallow merge, main.js:94: scalars and whole values)

- No `doneTag` key: with per-plan columns the done marker is `plan.doneColumn` (§3.1), so `DEFAULT_SETTINGS` (main.js:19-34), `drafts-meta.js` and `result()` (SettingsDialog.jsx:101-110) stay unchanged.
- `lastView: {type:'editor'} | {type:'plan', planId, tab} | {type:'flows', flowId}` (the last one is the flowchart library, flowchart plan §5.10; renderer fallback = editor; no default needed in main).
- Nothing else in settings (columns, units and WIP limits live in the plan file). Collapsed columns, task-list width, Backlog column visibility, last filter text: `localStorage` `daf-writer.plan.<planId>` (per-viewer convenience, the `daf-writer.snap` tier; every read/write in try/catch).

### 3.5 `planChart` node attrs (all `rendered: false`, stored in `data-json`)

```js
{
  id: 'q7w3e9r',                  // 7-char base36, unique in the document; agents address the node by it
  planId: '3f1c…',                // the plan it shows (uuid)
  view: 'kanban' | 'backlog' | 'gantt',
  options: Options,               // §3.2 Options; absent keys = defaults below
  frozen: null | { at, ctx },     // snapshot: {plan: pruned (keeps columns, doneColumn, units), tags, drafts: [{id,title,pushedAt}], draftTags}
  dw: null | number,              // display width in CSS px; null = content width
}
```

Option defaults: `title null` (= the view's generic name, "Kanban Board", "Backlog" or "Gantt Chart", user decision 2026-10-06; `''` = no title bar), `columns null` (all plan columns; a list of column ids, may include `null` for "No status"; ids of deleted columns are ignored), `labels null`, `priority null`, `hideDone false`, `doneWithinDays null`, `search ''`, `swimlane null`, `showDrafts true`, `unpushedOnly false`, `fields ['num','labels','due','checklist','priority','blocked','draft','pushed']`, `range null` (first start − 2 days … last end + 2 days), `zoom 'fit'`, `weekLabels 'date'` (`'number'` needs `calendar.weekOne`), `showDeps true`, `showCritical false`, `showBaseline false`, `showToday true`, `showTaskList true`, `showWeekends true`, `legend true`, `footer true` ("12 tickets · 3 done · generated as of 5 Oct 2026").

`parseChart(json)` (`src/plan-chart.js`, same shape as `parseBoard` whiteboard.js:137): bad JSON → defaults; missing/invalid `id` → `newId()`; unknown `view` → `'kanban'`; `options` → each key validated, invalid keys dropped; `frozen.ctx.plan` → `parsePlan`; `dw` → finite ≥ 40 or null. A frozen snapshot omits `description`, `urls`, `checklist` text (keeps counts) and `baseline` unless the view shows them. Frozen snapshots travel through persistent undo history as plain attrs (history.js dedups only data URLs): acceptable for a few hundred tickets (≈ 50–150 KB per snapshot).

### 3.6 Derived values (pure selectors, `src/plan/plan-model.mjs`)

- `statusOf(ticket, ctx)` → column id | null (derived through `columnForTag` for linked tickets).
- `columnForTag(ctx, tagId)` → column id | null (§3.1 read rule); `canDrop(ctx, card, columnId)` → `true` | `'unmapped_column'` (the write rule, shared by the reducer, the drag hint and the create-tag popup); `matchingTag(ctx, columnId)` → the id of an unmapped global tag with the column's name, or null (§3.1).
- `doneColumnOf(plan)` → `plan.doneColumn` if present, else the last column id.
- `unitOf(plan, id)` → `{id, name, daysPer}` (`d` → `{id: 'd', name: 'd', daysPer: 1}`); `estimateDays(plan, ticket)` → number | null.
- `cards(ctx, options)` → `[{kind:'ticket'|'draft', id, status, title, pushedAt?, ticket?, draft?}]`: tickets after `filterTickets`, plus (when `showDrafts`) drafts of the thread with no linking ticket; `unpushedOnly` keeps cards whose draft has `pushedAt == null`.
- `columnsOf(ctx, options)` → `[{id: null|columnId, name, color, tagId, wip, done}]`: "No status" first (only when it has cards or `options.columns` names it), then `plan.columns` in order filtered by `options.columns`.
- `tree(plan)` → `[{ticket, depth, children}]` in `order`.
- `summary(plan, ticketId)` for a parent: `{start: min, end: max, progress, estimateDays: sum}`, progress = mean weighted by `estimateDays` (by count when no estimates).
- `blockers(ctx, ticketId)` → predecessors not done; `ready(ctx)` → not done, no blockers, in `order`.
- `wipState(ctx)` → `{[columnId]: {count, limit, over}}` from `column.wip`, counting tickets and draft cards (advisory: never blocks a move).
- `describe(ctx, format)` → Markdown (one line per ticket: `#12 Title — <column name> · 3 pt · 8–13 Oct · deps #3`), Mermaid (`gantt`, `dateFormat YYYY-MM-DD`, `excludes weekends` + holidays, one `section` per top-level parent, `crit` on critical, `milestone`, `after` for FS deps), or the plan JSON.

### 3.7 Scheduling semantics (`src/plan/dates.mjs`, `src/plan/schedule.mjs`)

Working-day index: `work(date, cal)` = count of working days from the fixed epoch 2000-01-03 (a Monday) to `date` (O(1) over the weekday pattern, holidays subtracted by binary search over the sorted list); `fromWork(n, cal)` inverts it. All CPM arithmetic uses half-open indexes: a ticket has `s = work(start)`, duration `d = work(end) − s + 1` (milestone: `d = 0`, `e = s`), `e = s + d`.

Forward pass (tickets in topological order; unscheduled tickets — no dates — are excluded and their deps ignored for scheduling but still count for `blocked`):
- `es = max(s_stored, max over deps)`: FS `ef_pred + lag`; SS `es_pred + lag`; FF `ef_pred + lag − d`; SF `es_pred + lag − d` (the predecessor's earliest dates, so `autoScheduled` settles a chain in one pass; as built in A1). `ef = es + d`.
- `conflict = s_stored < es` (shown as a warning; nothing moves while `autoSchedule` is off).

Backward pass: `lf` of tickets without successors = project end (`max ef`); for each successor: FS `ls_succ − lag`; SS → `ls ≤ ls_succ − lag`; FF → `lf ≤ lf_succ − lag`; SF → `ls ≤ lf_succ − lag`; each written as a bound on this ticket's `lf` (`ls = lf − d`). `float = ls − es`; `critical = float === 0`. A ticket's `d` counts the working days from `start` through `end` (`work(end + 1) − s`, at least 1), so a stored date that a later holiday made non-working never lengthens it.

`autoScheduled(plan, ctx)` → plan with every conflicting ticket's `start` moved to `fromWork(es)` (end keeps the duration). Parents with children are skipped by both passes and summarised afterwards.

**Reference fixture** `test/fixtures/plan-sample.json` (Mon–Fri, no holidays inside its span (one on 2026-12-25 for the holiday command examples); 2026-10-05 is a Monday; indexes relative to the earliest start). This is the acceptance test for `schedule()` and, in Phase 3, for the on-screen Gantt:

| num | title | d | deps | es | ef | ls | lf | float | critical | start | end |
|---|---|---|---|---|---|---|---|---|---|---|---|
| #1 A | Design | 3 | — | 0 | 3 | 0 | 3 | 0 | yes | 2026-10-05 | 2026-10-07 |
| #2 B | Blockout | 2 | FS A | 3 | 5 | 5 | 7 | 2 | no | 2026-10-08 | 2026-10-09 |
| #3 C | Art pass | 4 | FS A | 3 | 7 | 3 | 7 | 0 | yes | 2026-10-08 | 2026-10-13 |
| #4 D | Playtest | 2 | FS B, FS C | 7 | 9 | 7 | 9 | 0 | yes | 2026-10-14 | 2026-10-15 |
| #5 M | Submission (milestone) | 0 | FS D | 9 | 9 | 9 | 9 | 0 | yes | 2026-10-16 | 2026-10-16 |
| #6 F | Write-up | 1 | SS C lag 1 | 4 | 5 | 8 | 9 | 4 | no | 2026-10-09 | 2026-10-09 |

Critical path A → C → D → M. Extra cases in the same test file: B stored at 2026-10-07 → `conflict` (es stays 3, bar drawn at the stored start); a stored start on Sat 2026-10-10 normalises to Mon 2026-10-12; `addDep(D → A)` refused `cycle`; a dep on a parent with children refused `parent_dep`; a holiday on 2026-10-08 shifts B/C/F by one working day; `autoScheduled` moves B to 2026-10-08 and keeps its 2-day duration.

## 4. Storage and IPC

Self-contained in Phases 0–3. Built on the shared `fileFamily` helper (`src/file-family.js`, agent-automation.md §4.1) from the start, in roadmap Stage 1, next to the flowchart library's `flows` family (flowchart plan §4): the main.js bullets below are what `fileFamily('plans', {keepPrevious: true, maxBytes: 8 MB, validate: planEnvelope})` does. There is no generic `api.store`:

**preload.js** (after `drafts`, 4 lines):
```js
plans: { list: call('plans.list'), load: call('plans.load'), save: call('plans.save'), remove: call('plans.remove') },
```

**main.js** (next to the draft functions; registered with `handle()` 373-378 so only the main window may call):
- `plansDir()` = `userData/plans`; `planFile(id)` validates `DRAFT_ID_RE` (12) like `draftFile` (100-103).
- `listPlans()` → full records (plans are small; drafts stay summaries), unreadable files omitted (as `listDrafts` 108-127); a `SyntaxError` file is renamed `.corrupt-<ts>` (settings precedent 85) and omitted.
- `loadPlan(id)` → record or null.
- `savePlan(plan)`: `isPlainObject` (176-178); `plan.id` uuid (generated when absent); `typeof plan.threadUrl === 'string' && TOPIC_URL_RE.test(plan.threadUrl)`; `JSON.stringify(plan).length ≤ 8 MB`; stamps `created` (first write) and `updated = Date.now()`; inside `serialized()` (49-54): `fs.copyFile(file, file + '.bak')` (ENOENT ignored) then `writeJsonAtomic(file, plan)` (65-76). Returns `{id, created, updated}`. Main checks the envelope only; `parsePlan` in the renderer owns the semantics.
- `removePlan(id)`: rename into `plans/.trash/` (pattern 160-174), also the `.bak`.
- `settings.get/set` and `DEFAULT_SETTINGS` unchanged.

**Renderer store `src/app/plans.js`**:
- `plans: Map<planId, plan>` loaded in `init()` (actions.js:753-764) after the drafts list and before the draft is opened (so `lastView` can be applied last); every record passes `parsePlan` then `pruneDrafts` (dirty ones are saved back once).
- `planFor(threadUrl)`, `planById(id)`, `planContext(id)` (§3.3), `subscribe(fn)`, `rev` counter per plan (incremented on every applied change; events carry it).
- `dispatch(commandId, args, {source})` (§8.2) is the only writer: reducer → undo entry → optimistic store update → persist. Persist order for a result `{plan, draftTags?, tags?}`: `saveSettings` with the keys the result carries (`tags`, `draftTags`) first, then `api.plans.save(plan)`; a failed second write toasts and leaves the first in place (both idempotent; the next dispatch re-saves). Plan writes are coalesced 300 ms per plan through one promise chain (like `saveChain`, actions.js:314-321); `closePlan`, `openDraft`, push and `beforeunload` flush it (`flushPlans()` next to `commitBoardEdit()` in those paths).
- Undo stack per plan: entries `{plan?, draftTags?}` = the plan before and after, and for `draftTags` only the drafts the dispatch changed (`{[draftId]: [before, after]}`, applied over the current `settings.draftTags`, so tag changes made elsewhere in between survive); ≤ 50, redo stack cleared on a new dispatch; in memory only, cleared on app close. `undoPlan(id)` / `redoPlan(id)` apply the entry with the same persist order. A global tag created by a drop (§3.1) stays on undo: undo restores the column's `tagId: null` and the drafts' previous tags, redo maps it again (settings have no undo, agent-automation.md §4.3 #9; the tag is deleted in the Settings tag manager).
- Reacts to `settings` changes (store subscription): `syncCompleted` for linked tickets when `draftTags` changed; when `tags` lost ids (compared with the previous `tags`; the Settings tag manager or, from Phase 4, the automation layer's `tags.remove`), `unmapTag(plan, removedId)` clears `tagId` on the column of every plan that maps it (one save per affected plan, no undo entry; unlinked tickets keep their column, linked ones already moved to "No status" because `pruneMap` dropped their `draftTags` entry, SettingsDialog.jsx:109). Tag renames and recolours do not touch plans.
- "Export plan…" writes the plan JSON through an `<a download="plan-<title>.json" href=blob:>` click (Electron shows the native save dialog for downloads); "Import plan…" reads an `<input type=file accept=.json>` with `FileReader`, runs `parsePlan` (columns, units and `tagId`s come with it; a `tagId` unknown to this install reads as unmapped), gives it a new id and the current thread, and confirms "Replace the plan of <thread> (12 tickets)?" when one exists. No new IPC.

## 5. Pure modules (Node-tested with `node --test test/*.test.*`)

They target the older of the two runtimes: `node --test` runs on the installed Node 22.16.0, while the Electron 44 renderer embeds Chromium 152 / Node 24.18.1. Nothing newer than Node 22 (e.g. `Temporal`) is used in them.

| File | Exports | Tests |
|---|---|---|
| `src/plan/dates.mjs` (no imports) | `toDay(str)→int` (UTC day ordinal), `fromDay`, `weekday`, `todayStr()`, `isWorkday(day, cal)`, `nextWorkday`, `prevWorkday`, `work(day, cal)`, `fromWork(n, cal)`, `addWorkDays(day, n, cal)`, `weekNumber(day, cal)` (from `weekOne`), `fmt(day, 'd MMM' \| 'MMM yyyy' \| 'Wk n')` (month/day names from `Intl.DateTimeFormat` with `timeZone: 'UTC'`; no `Temporal`, which the Node 22.16 test runtime lacks) | `test/dates.test.mjs`: leap day, weekend skipping, holidays, negative lag, week numbers |
| `src/plan/schedule.mjs` (imports dates) | `schedule(ctx) → {byId: {[id]: {s, e, d, es, ef, ls, lf, float, critical, conflict, blocked, ready, scheduled}}, span: {start, end}}`, `autoScheduled(plan, ctx)`, `hasCycle(tickets, extraDep?)` | `test/schedule.test.mjs`: the §3.7 fixture table verbatim, each dep type with lag, milestone zero duration, parent skip, cycle, holiday shift, conflict, autoScheduled |
| `src/plan/plan-model.mjs` (imports dates, schedule, `src/app/drafts-meta.js`) | `parsePlan(json, ctx?)`, `migratePlan(file)`, `newPlan(threadUrl, title, tags)` (seeds the three columns), `newTicket(plan, patch)` (assigns `num`, `unit = estimateUnit`), `statusOf`, reducers (all `(plan|ctx, …) → plan` or `{plan, draftTags}`; never mutate input; `{error}` on refusal): `addTicket, updateTicket(ids[], patch)` (field sets only: a patch carrying `deps`, `checklist`, `labels` or `urls` is refused), `removeTickets, moveTicket(ctx, ids, status, beforeId?, afterId?, {createTag}?)→{plan, draftTags?, tags?}, reorder, setParent, linkDraft(ctx, id, draftId)→{plan, draftTags}, unlinkDraft, setBaseline, clearBaseline`; per-entry list reducers, each naming one id and validating the resulting list (no whole-list setter, user decisions; precise edits, agent-automation.md §4.3 #11): `addColumn(ctx, column, beforeId?), updateColumn(ctx, id, patch), moveColumn(plan, id, beforeId?, afterId?), removeColumn(ctx, id, moveTo?), setDoneColumn, addLabel, updateLabel, removeLabel` (drops the id from every ticket), `addView, updateView, removeView, addUnit, updateUnit, removeUnit` (converts its estimates to days), `addHoliday, removeHoliday`; per-entry reducers for a ticket's sub-lists: `addDep, updateDep, removeDep` (keyed by the `from`/`to` pair), `addTicketLabel(plan, ids, labelId, replace?), removeTicketLabel(plan, ids, labelId), addCheck(plan, id, item, beforeId?), updateCheck, moveCheck, removeCheck, addUrl, updateUrl, removeUrl`; then `unmapTag(plan, tagId), pruneDrafts(ctx), syncCompleted(ctx), importTasks(ctx, tasks)`; selectors §3.6: `cards, columnsOf, columnForTag, canDrop, doneColumnOf, unitOf, estimateDays, filterTickets, tree, summary, blockers, ready, wipState, describe` | `test/plan-model.test.mjs`: parse drops bad data and maps an unknown status to `null`; `newPlan` seeds `todo`/`progress`/`done` with `tagId` only for tags present; a second column on the same tag refused `tag_taken`; `removeColumn` moves unlinked tickets to `moveTo`, leaves linked tickets on their tag, re-points a deleted `doneColumn`; every sub-list reducer changes only the named entry (the other entries `deepEqual` before and after), `updateTicket` refuses a patch carrying a sub-list, `addTicketLabel` with `replace` swaps one label on every named ticket, `updateDep` changes `lag` without touching other deps, an unknown entry id → `not_found`, a link without `id` gets one from `parsePlan`; derived status of linked tickets and draft cards (mapped tag, unmapped tag → `null`, untagged → `null`, `tagId` of a tag missing from `ctx.tags` → `null`); `moveTicket` on a linked ticket changes `draftTags` only; onto an unmapped column refused `unmapped_column`, and with `createTag` it adds one tag named and coloured like the column (or uses `matchingTag`), maps the column and tags the draft in one result; link/unlink copy rules incl. linking from an unmapped column; `unmapTag`; `completedAt` set/cleared with a custom `doneColumn`; `addUnit` / `updateUnit` refuse `daysPer ≤ 0`, a duplicate name and `d`, and `removeUnit` converts its estimates to days; `removeLabel` drops the label from every ticket; `estimateDays` and `summary` in days with mixed units; `importTasks` resolves temp ids, `end` wins over `days`, cycles refused; every reducer leaves its input `deepEqual` to a clone |
| `src/plan/gantt-layout.mjs` (imports dates) | `ganttLayout(ctx, sched, options, width) → {pxPerDay, left, rowH: 28, headerH: 40, rows: [{id, y, depth, kind, bar: {x, w}, progressW, baseline?, milestone?, summary?, critical, conflict, blocked}], ticks: [{x, label, major}], shading: [{x, w, kind}], today: x|null, deps: [{from, to, type, points: [[x, y]…], critical}], height, zoomUsed, note?}`; zoom table px/day `{day: 36, week: 10, month: 3, quarter: 1}`, `fit` = `(width − left) / spanDays` clamped 1…36; dependency polylines orthogonal with 12 px stubs; `hitTest(layout, x, y) → {kind: 'bar'|'edge-l'|'edge-r'|'progress'|'dep'|'port-s'|'port-e', id}` | `test/gantt-layout.test.mjs`: bar x/w per zoom, `fit`, range clamp, routing for each dep type, today x, `hitTest` zones, 60-row cap |
| `src/plan/plan-commands.mjs` (imports plan-model) | `PLAN_COMMANDS` descriptors (§8.1), `PLAN_GATES` (§8.2), `ticketRef(plan, ref)` (`#12` or uuid → id), `columnRef` / `unitRef` / `labelRef` / `viewRef(plan, ref)` (id or name → id), `importTasks` schema | `test/plan-commands.test.mjs`: ids unique and `^plan(\.[a-zA-Z]+)+$`, every `examples[]` entry runs its `plan()` against the fixture and yields a plan `deepEqual` to its own `parsePlan`, `risk`/`undo` in range, every id ending in `.delete` or `.remove` has `risk: 'destructive'` except the link removals `plan.deps.remove` and `plan.tickets.labels.remove` (agent-automation.md §5.2), no `.set` command has a top-level array argument, the `plan.tickets.update` patch schema has no `deps`, `checklist`, `labels` or `urls`, every `needs` entry names a `PLAN_GATES` id, `plan.columnRoom` fails at 10 columns and `plan.otherColumn` on the only column |
| `src/app/components/plan/drag.mjs` (no imports) | `dropTarget(cards, columns, x, y) → {column, beforeId|null}` over `[{id, column, rect}]`, `edgeScroll(d)` | `test/plan-drag.test.mjs` (like place.test.mjs) |
| `src/doc-utils.mjs` | `replaceWhiteboards` gains type `planChart`; new `chartRefs(doc) → [{id, planId}]` | `test/doc-utils.test.mjs`: a planChart between a whiteboard and a canvas gets `[[IMG:1]]`, `kind: 'planChart'`; `chartRefs` |
| `src/plan-chart.js` | `parseChart` (pure part tested by importing the module in Node: it must not touch `document` at top level, like whiteboard.js) | `test/plan-chart.test.mjs`: defaults, dropped keys, frozen snapshot through `parsePlan` |

**As built (A1, 2026-10-06)**, where the code differs from the table:
- Reducers: every reducer takes `ctx` first (one that needs only the plan reads `ctx.plan`) and returns `{plan, result?, draftTags?, tags?}` or `{error: {code, message, data?}}`, never a bare plan; `result` carries the command result (`{ticketId, num}`, `{columnId}`, `{moved}`, `{converted}`, `{tickets}`, `{tagId, created}`, …). Refs (`#num`, uuid; column, unit, label, view id or name) are resolved inside the reducers, so the resolvers live in `plan-model.mjs` and `plan-commands.mjs` re-exports them (`columnRef` returns `null` for "No status" and `undefined` when unknown). A reducer result's `draftTags` is the whole map with only the named drafts changed (`tagDraft` is not used: its `pruneMap` over the thread-filtered `ctx.drafts` would drop other threads' entries). `moveTicket`'s `beforeId` / `afterId` may also name a draft card (a Board drop above one): the status changes, `order` does not; any other unknown anchor → `not_found`.
- `schedule.mjs` also owns `doneColumnOf`, `columnForTag`, `statusOf` (needed for `blocked`); `plan-model.mjs` re-exports them, so there is no import cycle. Schedule entries of a parent with children carry `summary: true`; `span` is `{start, end}` as dates or null.
- `plan-model.mjs` also exports `updatePlan` (`plan.update`), `MAX_COLUMNS`, `COLORS`, `OPTION_DEFAULTS`, `parseOptions` (the Options checks, for A3's `parseChart`), `newId`, and defines `PLAN_GATES` (the reducers check them too; `plan-commands.mjs` re-exports them). It imports `DEFAULT_TAGS` from `drafts-meta.js` only. `parsePlan` enforces both-or-neither dates, `end ≥ start` and milestone `end = start`, but does not move stored dates to working days (the reducers do when they write dates or `milestone`), so adding a holiday never shifts dates on load. `updateTicket` refuses any key outside its field sets (incl. `status`); `setParent` refuses `parent_dep` when the new parent has dependencies; `linkDraft` refuses `exists` when another ticket links the draft; `removeColumn` also re-points a linked ticket's stored (ignored) status, so the file never names a deleted column; `removeTickets` moves children up to the nearest kept ancestor.
- `dates.mjs` also exports `normRange(start, end, cal, milestone)` (the §3.2 normalisation); `fmt` also takes `'d'`, `'MMM'`, `'yyyy'`, `'Qn'` (axis ticks) and the calendar for `'Wk n'`.
- `gantt-layout.mjs` imports `plan-model.mjs` too (`tree`, `filterTickets`, `summary`, `OPTION_DEFAULTS`): `ganttLayout(ctx, sched, options, width, {exporting, listW = 200})`; `exporting` applies §7.4 (at most `GANTT_MAX_ROWS` = 60 rows, the zoom fallback with `note`) and returns `{error: {code: 'too_many_rows' | 'range_too_long'}}`; the result also has `width`. A dependency hit is `{kind: 'dep', id: successor, from: predecessor}`.
- `plan-commands.mjs`: pure reads have `read(ctx, args)` (`plan.list`, `plan.get`, `plan.schedule` (with `byId` and `byNum`), `plan.ready`, `plan.describe`); the imperative ones (`plan.delete`, `plan.insertChart`, `plan.chart.set`, `plan.chart.list`, `plan.render`, `plan.open`, `plan.close`, `plan.undo`, `plan.redo`) carry no body yet. `plan.tickets.reorder` was added (§8.3). The contract test accepts `needs` from `PLAN_GATES` and from `gates.mjs` (`doc.open` for the chart commands).
- `drag.mjs` has no `edgeScroll`: `drag.js` uses `edgeSpeed` from whiteboard.js (§11).

## 6. UI and interactions

### 6.1 Where the workspace lives (view switch and focus)

- `store.js:6-33` gains `view: {type:'editor'} | {type:'plan', planId, tab:'board'|'backlog'|'gantt'} | {type:'flows', flowId}` (default editor; `flows` is the flowchart library, flowchart plan §5.10) and `planUi: {selection: [ticketId…], focusId: null, filter: ''}`.
- The workspace host is shared with the flowchart library (roadmap Stage 1): `openPlan` / `closePlan` call `openWorkspace` / `closeWorkspace` in `src/app/views.js`, which run the steps below for either workspace, and `#plan-root` in this plan is the shared `#workspace-root` element that holds `PlanPage` or `FlowsPage`. `BoardRail` renders in the editor and flows views, not in the plan view.
- `App.jsx:28-35`: inside the `relative` main wrapper, `<EditorPage/>` is always rendered; while `view.type === 'plan'` it gets `className="invisible pointer-events-none"` (`visibility: hidden` keeps layout: `contentWidth(view)` whiteboard.js:458-461, `applyZoom`, `homeView` and the `offsetWidth` probe in `export.js:36` keep working, so Push from the sidebar still exports nested boards at the right width) and the `inert` attribute (no focus, no hover). `<PlanPage/>` renders `absolute inset-0 z-10 bg-background` in the same cell. `BoardRail`, `Toolbar` and `SidebarToggle` render null in plan view (the sidebar toggle sits in the plan header); `ToolNotice` stays. `ItemRibbon`, `CanvasBar`, `CanvasEditBar` need no change: after `openPlan` no board is active, no canvas hovered (inert) or selected.
- `openPlan(threadUrl | planId, tab?, {startup, remember = true} = {})` in `src/app/plans.js`, in this order: `commitBoardEdit()`; `canvasEditor.get()?.close(true)`; `activeBoard.get()?.setMode(null)`; unless `startup`, `await saveNow()` (abort on failure); if the editor selection is a `NodeSelection`, dispatch `tr.setSelection(TextSelection.near(tr.doc.resolve(sel.to)))` inside `withoutScroll` (whiteboard.js:524); `editor.commands.blur()`; create the plan when missing (confirm `Create a plan board for "<thread>"?`, button "Create", skipped when `startup`); `setState({view})`; next frame `#plan-root.focus()`; `saveSettings({lastView})` unless `remember` is false (agent sources pass `remember: false`, as `openDraft` does, agent-automation.md §5.5, so `lastView` stays the user's). The active board therefore empties (`updateActive` whiteboard.js:630-638: no focus, no node selection, no mode).
- `closePlan({remember = true} = {})`: `flushPlans()`; `setState({view: {type:'editor'}, planUi: …reset})`; the editor focused on the next frame with `state.editor.view.focus()` (Stage 1 `closeWorkspace`: the selection comes back without scrolling to it; `commands.focus()` would scroll); `saveSettings({lastView: {type:'editor'}})` unless `remember` is false. Opening a draft from a card calls `closePlan()` then `openDraft(id)`. Switching or deleting a draft from the sidebar does **not** close the plan; `mountEditor` works behind it.
- Startup: `init()` loads plans after `api.drafts.list()`, opens the draft as today, then applies `settings.lastView` (`openPlan(planId, tab, {startup: true})` if that plan still exists; else editor).
- Focus return: `refocusEditor` (actions.js:183-186) and `returnFocus` (233-237) send focus to `#plan-root` instead of the editor while `view.type === 'plan'` (one `if`). `refocus(board)` (controls.jsx:30-34) is untouched (no board exists in plan view).
- Shortcuts: `onKeyDown` (actions.js:676-717) gains `Ctrl+Alt+P` (toggle the plan of the selected thread, else of the open draft's thread; no thread → the plan picker, as the Plans tab, §6.2) before the canvas guard, and `else if (state.view.type === 'plan') return;` right after it (699): Ctrl+S (also flushes plans), Ctrl+Space, Ctrl+Tab and window zoom stay global; Ctrl+K, Ctrl+\, Ctrl+Alt+W/C, the flowchart plan's Ctrl+Alt+F and Alt+1–9 are off in plan view. Ctrl+Tab in plan view is a no-op (`toggleQuickTools` returns when `view.type === 'plan'`).

### 6.2 Navigation and plan header

- **Plans tab** (the main entry point, user decision 2026-10-06): the left sidebar gets a fixed footer with two full-width tabs stacked vertically, **Plans** (`SquareKanban`) on top and **Flowcharts** (`Workflow`, flowchart plan §5.1) below. `Sidebar` (Sidebar.jsx:351-362) becomes a flex column: the `ScrollArea` with the four cards takes the free height, then `SidebarNav` (`border-t`, `p-1`; ghost buttons 32 px high with icon, label and shortcut hint, `onMouseDown={keepFocus}`). Plans shows a pressed state while the workspace is open, and a click there returns to the editor (`closePlan`). Otherwise it opens the plan of the selected thread, else of the open draft's thread (creating it after the §6.1 confirm), else the plan picker `planPick` (every plan, grouped by thread, with a "Without a thread" group for plans whose `threadUrl` is not in `settings.threads`; rows Open and Delete). Ctrl+Alt+P does the same. Roadmap Stage 1 adds the footer with both tabs; Flowcharts opens the per-thread flowchart library (flowchart plan §5.10). The footer is not rendered while the sidebar is collapsed; Ctrl+Alt+P and Ctrl+Space reach the plan then.
- Sidebar Threads rows (Sidebar.jsx:154-160), a second entry point: hover action **Plan board** (`SquareKanban`) before "Open in forum"; when the thread has a plan the row shows the open-ticket count (`text-xs text-muted-foreground tabular-nums`) before the hover actions. `removeThread` is unchanged (the plan moves to the picker's "Without a thread" group). There is no status-bar button and no sidebar group for plans without a thread: the Plans tab and the picker cover both.
- Plan header (`PlanHeader.jsx`, one 36 px row, `text-xs`): sidebar toggle (same component as `SidebarToggle`'s button) · thread label (`truncate`, tooltip full) · `ToggleGroup` Board | Backlog | Gantt (`SquareKanban` / `ListTodo` / `ChartGantt`, also keys 1/2/3 with Alt) · filter `Input` (placeholder "Filter… ( / )") · Labels menu (checkbox per label) · Priority menu · Hide done `Toggle` · Views menu (saved views: click applies its options; "Save current as…" opens a name `InlineInput` → `plan.views.add`; "Delete" per view → confirm → `plan.views.remove`) · `+ Ticket` (N) · Undo / Redo (plan stack) · overflow `DropdownMenu` (Set baseline, Clear baseline, Calendar… (dialog `planCalendar`: workdays checkboxes and the week-one date → `plan.update {calendar}`; holiday rows, each a `<input type=date>` with delete, and "Add holiday" → `plan.holidays.add` / `plan.holidays.remove`; every change runs at once as its own command and undo entry, one Close button), Auto-schedule (checkbox item), Labels… (dialog: rows name + colour swatch + delete, Add; every change runs at once as its own command and undo entry, and the dialog has one Close button: Add → `plan.labels.add` ("New label", next unused colour, name input focused), name (Enter / blur) or colour → `plan.labels.update`, delete → confirm "Remove the label 'Art' from 5 tickets?" → `plan.labels.remove`), Columns… (§6.3), Units… (dialog `planUnits`: a fixed first row "d — working day = 1 d"; then one row per custom unit: name `Input`, "= [number] d" `Input type=number step=any`, "Default" radio for `estimateUnit` (also on the `d` row), delete; "Add unit" (an empty row); every change runs at once as its own command and undo entry, with one Close button as in Labels…: a row's name or days (Enter / blur, after the inline check: name non-empty, unique, not `d`, `daysPer > 0`) → `plan.units.add` for a new row, else `plan.units.update`; Default → `plan.update {estimateUnit}`; delete → confirm "Remove the unit 'pt'?", with "4 tickets estimated in pt are converted to days (e.g. 3 pt → 1.5 d)" when tickets use it → `plan.units.remove`), Rename plan, Insert into draft…, Copy as Markdown, Copy as Mermaid, Export plan…, Import plan…, Delete plan) · **Back to editor** (`outline`, Escape when nothing is selected or open). Every header control carries `onMouseDown={keepFocus}` (Toolbar.jsx:30) except inputs, so `#plan-root` keeps keyboard focus; popups return focus to `#plan-root` via `refocusEditor`.
- Density per SPEC §7b: 13 px root, `text-xs`/`text-sm`, tight padding; at 1280×720 the Board shows three 260 px columns plus the "No status" column without clipping and scrolls horizontally beyond.

### 6.3 Board (Kanban)

- Columns from `columnsOf(ctx, options)` (§3.6): header = colour dot (dimmed ring for "No status"), name, a small `Tag` glyph when the column follows a status tag (tooltip "Draft cards follow the tag 'In progress'"), a `CircleCheck` glyph on the done column, count or `count/limit` (`text-destructive` when over; never blocks), collapse chevron (localStorage), `+` quick add, `…` column menu. A plan always has ≥ 1 column, so there is no empty state.
- Column management (per plan, user decision; 1–10 columns): the column menu has Rename (inline `InlineInput` in the header; Enter → `plan.columns.update`), Move left / Move right (`plan.columns.move`), Set as done column (`plan.update {doneColumn}`), Edit columns…, Delete column…. A `+ Column` ghost button after the last column adds "New column" with the next unused colour and opens its rename input; at 10 columns it is disabled with the tooltip "A plan has at most 10 columns" (the gate `plan.columnRoom` that `plan.columns.add` checks, §8.2). **Columns…** (dialog `planColumns`, also in the header overflow; rows like the Settings tag manager SettingsDialog.jsx:171-180): colour swatch (`<input type=color>` with the `SWATCH` class, SettingsDialog.jsx:67), name `Input`, status tag `Select` (global tags not mapped by another column + "None"), WIP `Input type=number` (empty = none), "Done" radio, up/down, delete; "Add column" (disabled at 10). Every row change runs at once as its own command and undo entry (no whole-list write, user decision; the dialog has one Close button): Add column → `plan.columns.add`; name (Enter / blur), colour, status tag, WIP → `plan.columns.update`; Done → `plan.update {doneColumn}`; up/down → `plan.columns.move`; delete → the Delete column… confirm → `plan.columns.remove`. **Delete column…** (menu or dialog row) confirms with the count and a target: "Move 4 tickets from 'Review' to [To do ▾]" (`Select` of the other columns + "No status", default the left neighbour); the description adds "2 linked drafts keep their status tag and show in 'No status'" when linked tickets or draft cards are in it, and "Done moves to 'Review'" when it is the done column; Delete = `dispatch('plan.columns.remove', {columnId, moveTo})`. The last column has no Delete (gate `plan.otherColumn`).
- Cards (`Card.jsx`, `data-card`): title (2 lines, `line-clamp-2`), then chips for the enabled `fields`: `#num`, labels (colour pills), due (`13 Oct`; `text-destructive` when `end < today` and not done, amber when `end === today`), checklist `2/5`, priority icon (`Flame` urgent, `ChevronsUp` high, `ChevronUp` medium, `ChevronDown` low), estimate (`3 pt`; tooltip `= 1.5 d` when the unit is not `d`), blocked (`Ban`, orange, tooltip lists blockers), draft chip (`FileText` + title; click opens the draft), pushed tick (`CircleCheck` green, as the sidebar), milestone (`Milestone`). Draft cards: title, `FileText`, pushed tick, a muted "draft" `Badge`; hover action **Convert to ticket**. A linked ticket or draft card whose tag no column maps shows a muted `Badge` with that tag's colour dot and name in the "No status" column.
- Selection: click selects one card (`planUi.selection = [id]`, `focusId`); Ctrl+click toggles; Shift+click selects the range within a column. Bulk: a drag moves every selected card (relative order kept); Del deletes the selection (confirm lists the count); P and the inline status menu apply to all selected (`plan.tickets.update` / `plan.tickets.move`); L toggles one label on all selected (`plan.tickets.labels.add` / `.remove`). Draft cards join a selection but only accept status moves.
- Drag: pointer events after 4 px (the `dragRow` pattern Sidebar.jsx:178-213, generalised in `drag.js`: `startDrag(e, {onMove, onDrop})` with `dropTarget` from `drag.mjs` over the `[data-card]` / `[data-column]` rects, insertion line above/below the target card, column highlight on empty space, horizontal auto-scroll of the column strip with `edgeSpeed` whiteboard.js:611). Drop → one `dispatch('plan.tickets.move', {ticketIds, status, beforeId})`; a draft card → its tag through the same command (§3.1 write rule; the reducer returns `{plan: unchanged, draftTags}`). While a selection containing a linked ticket or draft card is dragged, columns where `canDrop` fails (no `tagId`) show a dashed overlay "Follows no status tag: drop to create one" and no insertion line; a drop there opens the §3.1 popup once for the whole selection: Create (or Use tag) → one `dispatch('plan.tickets.move', {…, createTag: true})` that moves every selected card; Cancel → every card snaps back (no partial move). One dispatch = one undo entry.
- Swimlanes (`options.swimlane`): lanes by label (a ticket with several labels shows in its first; "No label" last), top-level parent ("No parent" last) or priority; lane header collapsible. Dropping into another lane changes that field with one dispatch: label lane → `plan.tickets.labels.add {labelId: laneLabel, replace: oldLaneLabel}` (the ticket's other labels stay), "No label" lane → `plan.tickets.labels.remove {labelId: oldLaneLabel}`; parent lane → `setParent` (refused with a toast on a cycle); priority lane → `priority`.
- Quick add: `+` at the column bottom (or N with a column focused) shows an `Input`; Enter → `addTicket({title, status})` at the top of the column, input stays open; Escape closes; a multi-line paste adds one ticket per non-empty line.
- Card click → `TicketDialog` (§6.6). Right-click → context `DropdownMenu`: status submenu (plan columns; an unmapped one chosen for a linked ticket or draft card opens the §3.1 popup), priority submenu, labels, Set as milestone, Open draft / Link draft…, Delete.

### 6.4 Backlog (table)

- Rows = `tree(plan)` (children indented 16 px per depth, chevron collapses; collapsed set in localStorage), filtered like the Board. Columns: drag handle, `#num`, title, status (inline `Select` of plan columns + "No status"), priority (inline), labels, estimate (`3 pt`), start, end (native `<input type=date>` inline on click), progress, deps / blocked, draft, checklist `2/5`. Column visibility menu (localStorage). Header click sorts (title, status order, priority, start, end, estimate, num); while sorted, row drag is disabled (GitHub behaviour) and a "Clear sort" chip shows.
- Row drag (same `drag.js`) → `reorder` within the same parent; dropping onto another ticket's row with Alt → `setParent`. Row click → `TicketDialog`. Footer: tickets, estimate sum converted to days (`Σ estimateDays`, e.g. "12.5 d"; tooltip lists the per-unit sums "8 pt + 8.5 d"), done %, blocked count.
- Unscheduled tickets are ordinary rows with empty date cells.

### 6.5 Gantt

- `Gantt.jsx` = resizable task list (title with tree indent, start, end, duration; width in localStorage, min 160 px; `showTaskList` toggle) + one `<svg>` from `ganttLayout` in a horizontally scrolling pane, header 40 px (two tick rows: day zoom "Oct 2026" / "5 6 7 …"; week "Oct" / "5 Oct" or "Wk 3" with `weekLabels: 'number'`; month "2026" / "Oct"; quarter "2026" / "Q4"). Unscheduled tickets in a tray under the chart (drag one onto the chart → `start = dropped day`, `end = addWorkDays(start, max(1, ceil(estimateDays)) − 1)`; no estimate → 1 day; e.g. 3 pt at 0.5 d → 2 working days).
- Zoom `ToggleGroup` Day | Week | Month | Quarter | Fit; Ctrl + wheel over the chart steps the zoom keeping the date under the pointer fixed; horizontal wheel / Shift + wheel scrolls time; "Today" button scrolls today to the left third.
- Drawing: bar `rx 4` fill = first label colour else the status column's colour (`#555` for No status), progress as a darker inner bar, title inside when it fits else right of the bar; milestone = diamond; parent = thin bracket spanning its summary; baseline = grey ghost bar below the bar (`showBaseline`); critical = 2 px `#e05252` outline (`showCritical`); conflict = `#e09952` outline + tooltip "Starts before its predecessors allow (earliest 8 Oct)"; blocked = `Ban` glyph at the bar start; today = dashed accent line; weekends/holidays shaded; dependency lines orthogonal with an arrowhead at the successor end, `#e05252` when both ends are critical and `showCritical`.
- Gestures (pointer capture, zoom-aware via `getBoundingClientRect().width / offsetWidth`, snapping to whole working days, DOM-only during the gesture, one `dispatch` on pointerup):
  - bar body → move keeping the working-day duration; Shift also moves every successor forward by the same number of working days (a modifier, not a setting);
  - left / right 8 px edge → start / end, minimum 1 working day; a milestone's single handle moves it;
  - progress triangle under the bar → progress in 5 % steps;
  - **dependency drawing**: hovering a bar shows a port circle at each end; dragging from a port to another bar draws a ghost polyline; drop on the target's left half → `*S`, right half → `*F`; the source port gives `F*` or `S*` (end→start = FS, start→start = SS, end→end = FF, start→end = SF); the drop is one `plan.deps.add`. Illegal drop (self, cycle, parent, same dep exists) → red ghost, nothing happens, toast with the reason. Alt-dragging a dependency's middle segment edits `lag` ±1 working day per step, one `plan.deps.update` on pointerup.
  - click a dependency → selected (thicker); Del removes it (`plan.deps.remove`); double-click opens the successor's dialog at Dependencies.
  - double-click a bar → `TicketDialog`; right-click → the §6.3 context menu plus Set as milestone, Remove dates.
- Auto-schedule (plan setting, header menu): off (default) flags conflicts and moves nothing; on runs `autoScheduled` after every dispatch that changes dates or deps (toast once per session "Auto-schedule moved 2 tickets").
- Rows cap: the workspace renders all rows; the exported chart refuses above 60 (§7.4).

### 6.6 Ticket dialog

`TicketDialog.jsx` on the `FormDialog` shell (FormDialog.jsx:8-32), registered in `FORMS` (Dialogs.jsx:47) as `ticket`; `openDialog('ticket', {planId, ticketId | draft})`. Fields (two columns at ≥ 720 px, one below): title `Input`; description `Textarea` (shadcn CLI — the one new UI component); status `Select` (plan columns + "No status"; disabled with the note "Status follows the linked draft's tag 'In progress'" while linked; move the card instead); priority `Select`; labels (checkbox list + "New label…" inline name + colour); estimate `Input type=number` + unit `Select` (`d` + `plan.units`; default `plan.estimateUnit`; a muted "= 1.5 d" after it when the unit is not `d`); start / end `<input type=date>`; milestone `Checkbox` (locks end = start); progress `Slider` (disabled in done); parent `Select` (tickets minus descendants); dependencies rows (predecessor, type `Select`, lag `Input type=number`, remove; "Add dependency"); checklist rows (`Checkbox`, text `Input`, up/down, remove; "Add item"; Enter in the last item adds one); draft `Select` (drafts of the thread + "No draft"; "Open draft" button; changing it = link/unlink with the §3.1 rules, explained in a one-line note); urls rows (url, title, Open, remove; "Add link"); baseline read-only line; `#num`, created/updated/completedAt footnote.

Two modes (user decision 2026-10-06: each row change is one command; precise edits, agent-automation.md §4.3 #11):
- **New ticket** (`+ Ticket`, N outside the Board, Convert to ticket): footer Cancel · OK. OK = one `plan.tickets.create` carrying every field and the initial rows (a new entry, nothing replaced) = one undo entry. Validation (`validate()`): dates both or neither, end ≥ start, estimate ≥ 0, urls `https?://`.
- **Edit** (card, row or bar): every change runs at once as its own command and undo entry, as in Columns…, Labels… and Units… (§6.2, §6.3); footer Delete (confirm) · Close. Fields send on Enter, blur or change: title, description, priority, estimate + unit (one field set), start + end (one field set, sent only when both are dates with end ≥ start or both are empty; otherwise an inline error and nothing is sent), milestone, progress, parent and draft (link/unlink, §3.1) → `plan.tickets.update {ticketIds: [id], patch: {<that field set>}}`; status → `plan.tickets.move`. Rows:
  - dependencies: a new row's predecessor `Select` sends `plan.deps.add` once picked (the predecessor is fixed after that; to change it, remove the row and add another); type and lag → `plan.deps.update`; remove → `plan.deps.remove`. A cycle or parent dep shows the refusal inline and adds nothing.
  - labels: check → `plan.tickets.labels.add`, uncheck → `plan.tickets.labels.remove`; "New label…" = `plan.labels.add`, then `plan.tickets.labels.add` for this ticket (two entries).
  - checklist: "Add item" opens an empty row that becomes `plan.checklist.add` on Enter or blur with text (an empty row is dropped); checkbox and text → `plan.checklist.update`; up/down → `plan.checklist.move`; remove → `plan.checklist.remove`.
  - links: "Add link" opens an empty row that becomes `plan.urls.add` once the url is valid; url and title → `plan.urls.update`; remove → `plan.urls.remove`.
  Removing a row here does not confirm: it is one row, and Ctrl+Z restores it (§8.4).

### 6.7 Keyboard (focus inside `#plan-root`, not in an input, textarea, menu or dialog)

Common: `1`/`2`/`3` with Alt switch tabs; `/` focuses the filter; `N` new ticket (Board: in the focused column; others: at the end); `Enter` opens the focused card/row/bar; `Del`/`Backspace` deletes the selection (confirm) or the selected dependency; `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z` plan undo/redo; `Ctrl+A` selects all visible cards/rows; `Escape` ladder: close popup → clear selection → Back to editor; `Ctrl+Alt+P` Back to editor.
Board: arrows move focus (←/→ same index in the neighbour column), `Shift+←/→` move the selection to the neighbour column (an unmapped one asks like a drop), `Shift+↑/↓` reorder within the column, `D` toggle done (`doneColumnOf` ↔ previous column; asks like a drop when a linked card would land on an unmapped column), `L` labels menu, `P` priority menu, `C` convert draft card.
Backlog: ↑/↓ focus, `Shift+↑/↓` reorder, `→`/`←` expand/collapse.
Gantt: ↑/↓ focus, `←/→` move the bar one working day, `Shift+←/→` resize end, `Ctrl+←/→` resize start, `T` today, `+`/`−` zoom, `Tab` cycles the focused bar's dependencies.

### 6.8 Undo and persistence from the user's view

Every gesture, menu action, new-ticket OK and field or row change in the ticket, Columns…, Labels…, Units… and Calendar… dialogs is one dispatch = one undo entry; a draft card move is undoable (the entry restores the moved drafts' tags), including a drop that created a matching tag (the tag itself stays, §4). Undo/redo buttons and Ctrl+Z work only in the plan view; the document's history is untouched by plan work. Saves are invisible (no status-bar label); a failed plan save toasts "Could not save the plan: <message>" and the next change retries.

### 6.9 Settings dialog changes

Only the tag delete changes; tag rows (SettingsDialog.jsx:171-180) and `result()` (101-110) stay as they are (no "Done" radio: done is per plan). `deleteTag` (86-94) also confirms when a plan column maps the tag (today it confirms only when drafts carry it), and the description adds "N plan columns stop following it (their tickets stay; linked drafts move to No status)" when `unmapTag` would touch any plan (computed from the loaded plans). Renaming or recolouring a tag leaves plan columns alone. `openSettings` (actions.js:606-619) is unchanged; the plan store reacts to the saved `tags` (§4).

### 6.10 Tool search and quick tools

- `toolContext` (tools.js:24-27) adds `view: getState().view`; `inText` (29) becomes `!c.board && !!c.ed && c.view.type === 'editor'`; new `inPlan = (c) => c.view.type === 'plan'`. Both are built from the gates of `gates.mjs` (seeded in roadmap Stage 1: `doc.open`, `view.editor`, `view.plan`, `view.flows`; agent-automation.md §3.7, flowchart plan §7.2), and Plan entries declare `needs` like every other entry; they live in `src/app/tools-plan.js`, spread into `TOOLS`. Roadmap Stage 1 appends the group `'Plan'` to `GROUPS` (ToolSearch.jsx:15), next to the flowchart plan's `'Flowchart'`. Entries: `plan-open` ("Open plan board", `SquareKanban`, when editor view and a thread is known), `plan-board` / `plan-backlog` / `plan-gantt` (`inPlan`), `plan-new-ticket` (`inPlan`), `plan-insert-chart` ("Insert plan chart", `inText`, §7.1), `plan-close` ("Back to editor", `inPlan`), `plan-undo` / `plan-redo` (`inPlan`; the existing `undo`/`redo` entries get `when: … && !inPlan(c)`). Keywords: kanban, board, tickets, backlog, gantt, timeline, schedule, chart, plan, sprint, todo, task.
- Ctrl+Space in plan view: `toggleToolSearch` records `focus = #plan-root` so `returnFocus` lands there. Quick tools (Ctrl+Tab): no-op in plan view.

### 6.11 As built (A2, 2026-10-06)

Where the code differs from §4, §6 and §8.2 (SPEC §7f describes what was built):
- `planUi` = `{selection, focusId, filter, options}`: `options` holds the header's label, priority and hide-done filters (a saved
  view applies its options and tab). Opening a plan resets it.
- A card click opens the ticket dialog and selects the card (Ctrl+click toggles, Shift+click selects a range from the focused
  card); there is no separate "click selects" step. The card menu is the card's ⋯ button, also opened by a right-click (no
  context-menu component is installed). Quick add opens from the + in the column header, at the top of the column.
- Workspace cards also show the estimate chip (the chart default `fields` plus `estimate`).
- Columns… and Units… use a Toggle for "Done" / "Default" (no radio component is installed). Columns…'s delete closes the
  dialog, Delete column… asks for the target, then Columns… opens again (one form dialog at a time).
- `dispatch` runs builder and read commands only; the imperative ones are plain functions of `src/app/plans.js` (`openPlan`,
  `undoPlan`, `redoPlan`, `deletePlan`, `importPlan`, …) and `dispatch` answers `unknown_command` for them until C4 gives them
  `run`. The UI toasts a failed command unless it passes `quiet` (the drop does, to ask the create-tag question instead).
- Settings values a command returns are shown at once and sent at once; the plan write is chained after them (not the other way
  round through one 300 ms timer).
- Import plan… keeps this plan's title (and takes a new id and this thread); the replaced plan goes to the trash.
- Not in A2: Calendar…, Set / Clear baseline and Auto-schedule in the header (roadmap A4 owns them: `planCalendar` with them),
  Insert into draft… (A3), swimlanes (§6.3), collapsed columns and the other per-viewer `localStorage` values (§3.4), the L / P
  menu keys (§6.7), and the toast when two plans name one thread (the newest is used).

### 6.12 As built (A4, 2026-10-06)

Where the code differs from §6.2, §6.5, §6.7 and §7 (SPEC §6e and §7f describe what was built):
- The Gantt view options (zoom, showDeps / Critical / Baseline / Today / Weekends / TaskList, weekLabels) are part of
  `planUi.options` with the header's filters, so saved views and Insert into draft take them; opening a plan resets them like
  the filters. Only the task-list width is per viewer (`ganttListW`, default 300 px). The zoom and Show controls are a toolbar row
  of the Gantt tab, not the header.
- The workspace draws with the chart's SVG pieces (`GanttTicks`, `GanttGrid`, `GanttDeps`, `GanttRows` in ChartView.jsx) in an
  app palette, so the tab and the exported chart draw the same; the task list is HTML (sticky beside the chart) in the tab and SVG
  text in the chart.
- Shift-move moves every successor transitively, in both directions, by the same working days. A gesture that changes several
  tickets is one undo entry through `dispatchAll(planId, [[commandId, args]])` in src/app/plans.js (builder commands without
  gates, run in sequence, applied once); Calendar… uses it for a holiday moved to another date. Other grouping (§13) is still
  not built.
- Auto-schedule runs inside `dispatch` / `dispatchAll` after `plan.update`, `plan.holidays.*`, `plan.tickets.create` /
  `.update`, `plan.deps.add` / `.update` and `plan.import`, and its moves are part of that command's undo entry (so turning it on
  moves the conflicting tickets at once, and one Ctrl+Z turns it off and puts them back).
- A dependency drop counts anywhere on the target's row (left / right of the bar's centre), not only on the bar; Alt-drag works
  on any segment of a dependency line and shows "Lag +n d" at the pointer while dragging.
- During a gesture the axis keeps its start (with Fit also its end; since the pre-rendered timeline, Fit's scale and the end as
  a minimum, below), so nothing jumps; a bar dragged past a kept edge is drawn clamped until the release, which applies the full
  value.
- The right-click menu is Gantt.jsx's own (Card.jsx's card menu is not exported): Open…, Status, Priority, Labels, Milestone,
  Remove dates, Open draft / Link draft…, Delete…. Double-click on a dependency opens the successor's ticket dialog and scrolls it
  to its dependencies (the dialog has no section argument). The task list has no collapse (the Backlog has); parents are not in
  the unscheduled tray; a click on a tray ticket opens it. The progress triangle shows under the focused or hovered task bar.
- Export: `chartLayout('gantt', …)` lays the chart out at the drawn width (never scaled) with `ganttLayout(…, {exporting:
  true})` (`chartGantt` in src/plan-chart.js); refusals read "more than 60 rows — filter it in Options" and "the date range is too
  long for the post width — shorten it in Options". The zoom fallback note joins the footer, or stands alone with the footer off.
  `freezeCtx(ctx, view)` keeps the baselines for a Gantt chart. The chart bar's Options… for a Gantt has a Timeline section (range
  dates and Whole plan, zoom, week numbers, the show keys) instead of the card fields, and no draft-card options.
- Tests: `test/gantt-chart.test.mjs` (chartLayout's Gantt rules, freezeCtx); the gantt-layout suite already covered `hitTest` and
  the fallback (A1). Smoke: the frozen Gantt chart is `dw` 960 with critical path and baselines (two that slipped).
- Pre-rendered timeline (2026-10-06, after A4): the workspace's axis no longer stops 2 days after the tickets.
  `ganttLayout(…, {fill: {from, to, px}})` (workspace only; export keeps the ±2-day range) adds one zoom unit before the tickets
  (3 / 7 / 31 / 92 days; Fit 3), at least two weeks after them, the days `from` … `to`, and days up to the right edge (a filled
  last day is cut at the edge rather than scrolled to); Fit fits tickets + lead-in + tail (≤ 36 px a day) and fills the rest. The
  layout returns its `start` / `end` day numbers, which Gantt.jsx uses instead of re-deriving the range. Within 100 px of either
  end (sideways scroll, Shift + wheel at an end) or with a gesture held in the 48 px edge zone (`edgeSpeed`, as the Board), the
  axis grows by half a screen (per visit, kept across zoom steps); a left growth shifts the scroll by the same px. A gesture now
  keeps the start, the end as a minimum and Fit's px per day (instead of Fit's end), so the end may grow during a drag; the
  start never grows during a gesture (the gesture's coordinates assume it), so a bar dragged left past the lead-in at scroll 0
  is still drawn clamped until the release. With no scheduled ticket the empty body draws the grid and today line.

### 6.13 As built (ticket defaults and date fields, 2026-10-06)

Where the code differs from §3.2, §6.4, §6.6 and §9 (SPEC §7f describes what was built):
- New tickets are Medium (priority 3): `newTicket`'s default, so `plan.tickets.create` and `plan.import` without a priority, the
  Board's quick add (in its column) and the new ticket dialog (the first column, or the converted draft card's status) all start
  there. An explicit priority (0 = none included) is kept; `parsePlan` still reads a stored ticket without one as 0.
- Date fields are `DateField` (src/app/components/DateField.jsx) instead of bare `<input type=date>` (user request): the native
  input for typing plus the shadcn `calendar` (CLI; react-day-picker 10) in a `Popover`, Chromium's picker indicator hidden, the
  button out of the Tab order (Alt+↓ or F4 opens it). Used by the ticket dialog, Calendar…, the Backlog date cells and the chart bar's
  Options range; each keeps its commit rule, a picked day commits at once. The popover focuses its start day in
  `onOpenAutoFocus`: focused earlier (DayPicker's `autoFocus`), a dialog's focus trap takes the focus back. It is not in
  `one-open.js`: a non-modal popover closes on any press outside it. In the chart bar the calendar carries `data-chart-bar`
  (hovering it keeps the bar), and the Options popover stops mousedown before the bar's `keepFocus`, which React would
  otherwise reach through the portal and so block focusing the popover's inputs and opening the calendar's month / year menus.
- Bundle: +79 kB minified renderer (react-day-picker 42 kB, its date-fns 28 kB, calendar.jsx 5 kB, DateField 2 kB) and +6 kB CSS,
  where §9 chose the native input at 0 kB. date-fns is react-day-picker's dependency, not a direct one.

### 6.14 As built (unscheduled rows, stable axis, remembered tab, 2026-10-06)

Where the code differs from §6.5 and §6.12 (user reports: a child without dates and its parent vanished from the Gantt; a
released drag made the axis jump; the Plans page forgot its tab):
- The unscheduled tray is gone. `ganttLayout(…, {unscheduled: true})` (the workspace; the exported chart keeps scheduled tickets
  only) gives every ticket that passes the filters a row in tree order, dated or not: `{kind: 'unscheduled', bar: null}`, no
  dependency lines to or from it, and `hitTest` → `{kind: 'lane', id}` on it (after the dependency lines). The task list shows
  "Unscheduled" (muted) across Start / End / Days, a parent without a scheduled child "—". Show › Unscheduled tickets
  (`options.showUnscheduled`, default on; not a saved-view key, `parseOptions` drops it) hides those rows.
- Scheduling in place: a click in a lane sets start = end = that working day; a drag across it draws the span (preview while
  the pointer is down, one `plan.tickets.update` on release); a parent's lane toasts "Schedule its subtasks…" and shows that
  text at the pointer. The hover ghost is a 30 % accent bar one day wide.
- Dated creation: `newTicket(planId, init, {from})` in src/app/plans.js; `from` defaults to today while the Gantt tab is shown,
  so + Ticket, N, the palette's New ticket and the empty chart's + Ticket in that tab date a ticket the dialog left without
  dates (`nextWorkday(from)`, estimate in working days via units, at least 1, a milestone 0: the old tray rule). The bar / row
  menu's Add subtask… passes `{parent}` (the dialog's Parent prefilled: `init.parent`) and `from` = the parent's scheduled
  start, else today. Board and Backlog paths (quick add, Convert to ticket) stay unscheduled.
- Stable axis: Gantt.jsx keeps a pin {from, to, px} per zoom / Weekends / range: each render passes the last start and end as
  `fill.from` / `fill.to` (so the axis only grows) and, while the chart's width is unchanged, Fit's px. Whenever the drawn start
  moves earlier at the same px the scroll shifts by the added days (this replaced the left-growth-only shift). A gesture keeps
  only its start (`hold`); the end and Fit's scale come from the pin. Leaving the tab (unmount) resets it.
- Remembered tab: `setPlanTab` saves `settings.planTab` with `lastView`; `openPlan`'s default tab is `settings.planTab ??
  'board'` (the sidebar's Plans tab, a thread row, Ctrl+Alt+P), and an explicit tab (a chart's Open plan) is saved too unless
  `remember: false` (startup restore, agents).

## 7. Insertion into drafts and export

### 7.1 Inserting

Entry points: the **Insert plan chart** button in the bottom toolbar (user decision: the toolbar island is where insertable elements live): `textTools().planChart` (Toolbar.jsx:44-101: `{title: 'Insert plan chart', onClick, children: <SquareKanban/>}`) plus a `ToolButton` in the toolbar's insert group (Toolbar.jsx:301-308), after the flowchart plan's Insert flowchart button, which follows the canvas button; the same button in the quick tools' insert group (QuickTools.jsx:52-58). Both list their buttons explicitly; the rail's text mode (BoardRail.jsx:135-161) is left as it is. Further: the `plan-insert-chart` palette entry; the plan header's "Insert into draft…" (closes the plan and inserts with the current tab's view and the current filter/zoom options: what I see is what I insert; a saved view can be picked instead); `plan.insertChart` (§8). Default `planId` = the plan of the open draft's thread; when there is none a `Select` dialog lists plans (or offers "Create a plan for this thread"). Insertion: `afterNodeSel(chain).insertPlanChart(attrs)` → `insertBoard(tr, topLevelPos(state.selection.$to), node)` (whiteboard.js:52-58); `id = newId()`, `dw = null`.

### 7.2 Node and NodeView (`src/plan-chart.js`)

- `PlanChart = Node.create({name: 'planChart', group: 'block', atom: true, selectable: true, draggable: false})`; attrs §3.5 all `rendered: false`; `parseHTML: div[data-plan-chart]` → `parseChart(data-json)`; `renderHTML` → `['div', {'data-plan-chart': '', 'data-json': JSON.stringify(attrs)}]`; commands `insertPlanChart(attrs)`, `setPlanChart(id, patch)` (finds the node by `attrs.id` with `doc.descendants`, one `setNodeMarkup` + `closeHistory`). `addKeyboardShortcuts`: Enter on a node-selected chart → `openPlan(planId, tabOf(view))`. Registered in `buildExtensions` (extensions.js:220-245) after `Canvas`.
- The module reads plan data through a seam it exports and `src/app/plans.js` fills at init (so the editor layer never imports the app layer, like `Canvas.addStorage().openItem` canvas.js:657-659): `planSource = { context: (planId) => ctx | null, subscribe: (fn) => unsubscribe }`.
- `PlanChartView` (pattern CanvasView canvas.js:135-273): `dom = div.pc` (`position: relative; margin: 1em 0; width: min(dw px, 100%)` or `100%` when `dw` null; `user-select: none`), `dom.pcView = this`; a React root `createRoot(inner)` renders `<ChartView ctx view options palette={pagePalette(theme)} readOnly/>` on construction, in `update(node)` and on `planSource` changes (live charts subscribe; frozen ones use `frozen.ctx`); `root.unmount()` in `destroy()`. Missing plan → placeholder "Plan not found — pick a plan or delete this chart" (`.pc-missing`, dashed outline). Events: `pointerdown` → `editor.commands.setNodeSelection(getPos())` + `view.focus()` (canvas.js:198-205); `mousedown` `preventDefault` (no caret); `dblclick` → `openPlan`; `stopEvent(e)` → `!['paste', 'drop', 'dragover', 'dragenter', 'dragleave'].includes(e.type)` (canvas.js:242-244, so `WhiteboardPaste` keeps working); `ignoreMutation` → true; `selectNode`/`deselectNode` toggle `.pc-selected` (2 px accent outline, `--wb-inv` scaled) and add/remove one east-edge handle (`.pc-handle`, 8 px strip) that drags `dw` (40 ≤ dw ≤ `contentWidth(view)`; live DOM, one `setNodeMarkup` on pointerup). No aspect lock: height follows content. `ChartView` height: Kanban/Backlog natural; Gantt `ganttLayout().height`.
- Chart bar (`PlanChartBar.jsx`, one instance in App next to `CanvasBar`, following the node-selected else hovered `.pc` through an `activeChart` store built like `activeCanvas` canvas.js:95-130, placed with the same `useFollow` logic): view `ToggleGroup` · **Options…** `Popover` (title; columns checkboxes from the plan's columns incl. "No status"; labels; priority; hide done + "done within N days"; swimlane; show drafts; unpushed only; fields checkboxes; range start/end `<input type=date>` + "Whole plan"; zoom; week labels; show deps / critical / baseline / today / weekends / task list; legend; footer) · plan `Select` · **Live / Frozen** `Toggle` (Freeze stores `frozen = {at, ctx: pruned}`; Unfreeze clears it; a frozen chart shows "Frozen 5 Oct 14:02" and a Refresh button that re-freezes) · size label `<dw or content> × <height>` · "Full width" (dw = null) · Open plan · Delete. Every change = `setPlanChart(id, patch)` (one undo step); buttons `onMouseDown={keepFocus}`, bar marked `data-board-chrome` and `data-chart-bar` (hover keeps it shown).
- `ChartView` (`src/app/components/plan/ChartView.jsx`) is the one renderer for the workspace (`readOnly: false`, app palette), the NodeView and the rasterizer (`readOnly: true`, page palette). It takes `{ctx, view, options, palette, width?, readOnly, onDispatch?}` and uses only inline styles and SVG attributes for everything that must export identically; `pagePalette(theme)` maps SPEC §1 colours (`bg #303039 / #ffffff`, text `#c5c6d0 / #333340`, muted `#a3a6b8 / #6b6d80`, border `#6b6d80 / #d0d0da`, accent `#3d99f5`, critical `#e05252`, conflict `#e09952`, done `#62d926`); the workspace passes the app chrome palette.

### 7.3 Export

- `replaceWhiteboards` (doc-utils.mjs:39): the type test becomes `!['whiteboard', 'canvas', 'planChart'].includes(child.type)`; `kind: child.type` already follows.
- `export.js:36`: selector `'.wb, .sc, .pc'`.
- `export.js:42-52` new branch `board.kind === 'planChart'`: `width = widths[i] || Math.min(board.dw ?? settings.forumWidth, settings.forumWidth)`; `({blob, height} = await rasterizePlanChart(board, {width, theme: settings.theme}))`; name `plan-<n>.png`; the > 19 MiB JPEG fallback (56-60) unchanged.
- `rasterizePlanChart(attrs, {width, theme})` in `src/plan-chart.js`: `ctx = attrs.frozen?.ctx ?? planSource.context(attrs.planId)`; none → `throw new Error('Plan chart <n>: plan not found (freeze it or pick a plan)')` (push shows it in "Push failed"; never a blank image). Readability check (§7.4) → `{layoutWidth, note}` or throw. Host `div` `position:fixed; left:-100000px; top:0; width:<layoutWidth>px` appended to `document.body` (whiteboard.js:2030-2036); `createRoot(host)`, `flushSync(() => root.render(<ChartView … width={layoutWidth} readOnly palette={pagePalette(theme)} note={note}/>))`; one `requestAnimationFrame`; `height = host.offsetHeight` (≤ 8000, else throw "Plan chart <n>: too tall — filter it"); `toBlob(host, {pixelRatio: 2, width: layoutWidth, height, backgroundColor: resolveBg('post', theme), skipFonts: true})`; `root.unmount(); host.remove()`. Returns `{blob, width, height: Math.round(height * width / layoutWidth)}` (`width` = display width in the post; the forum scales the image when `layoutWidth > width`).

### 7.4 Readability contract (numbers; enforced by the exporter, previewed in the options popover)

- Base font 13 px CSS in the chart; display scale `width / layoutWidth` must be ≥ 0.8 (effective ≥ 10.4 px).
- Kanban: N visible columns → `layoutWidth = max(width, N·180 + (N−1)·12)`; scale < 0.8 → throw "Plan chart <n>: too many columns for the post width — hide columns in Options". At 1454 px: ≤ 7 columns unscaled, 8–9 scaled, ≥ 10 refused, so a chart of a plan at the 10-column maximum (plus "No status") must hide at least 2 columns; the options popover says so before push. Cards wrap titles to 2 lines; ≤ 200 cards per chart, else refused.
- Backlog: `layoutWidth = max(width, sum of visible column minimums)`; ≤ 80 rows, else refused ("filter or collapse parents").
- Gantt: ≤ 60 rows, else refused. Zoom: the requested zoom is used when `spanDays · pxPerDay ≤ width − taskListWidth`; otherwise the next smaller zoom (day → week → month → quarter → fit) and the footer notes "12 weeks shown at week zoom". `fit` always fits (pxPerDay ≥ 1; a span over `width − left` days is refused "range too long").
- Minimum sizes: bar height 18 px, row 28 px, header 40 px, dependency stroke 1.5 px, arrowhead 6 px.

### 7.5 Smoke

`sampleDoc()` (actions.js:797-860) gains two frozen charts: a kanban (4 tickets across the 3 seeded columns and one custom unmapped column, 1 draft card, 1 blocked, one estimate in a custom unit) and a gantt (the §3.7 fixture, `showCritical`, `showBaseline`), both with `frozen.ctx` embedded so `npm run smoke` needs no plan file. `__smoke` output keeps its shape; `images` gains two entries (`plan-<n>.png`, numbered after the boards before them; the flowchart plan also adds a canvas to `sampleDoc`). The smoke acceptance checks both PNGs are non-empty and their widths equal the drawn widths.

### 7.6 As built (A3, 2026-10-06)

Where the code differs from §3.5, §6.4 and §7 (SPEC §6e and §7f describe what was built):
- `planSource` is `{context, subscribe, Chart, open}`: src/app/plans.js also hands over the renderer (`ChartView`) and the open
  function, so src/plan-chart.js imports no app module and stays loadable by `node --test`. `subscribe` fires after any plan
  change and after any change of the settings or the draft list (draft tags move draft cards). `pagePalette`, `chartLayout`
  (the §7.4 numbers), `backlogRows`, `BACKLOG_COLS` and `freezeCtx` live in src/plan-chart.js.
- `ChartView` draws only the chart node and the rasterizer (read-only). The workspace keeps A2's interactive `Kanban.jsx`, and the
  Backlog tab is its own `Backlog.jsx`; both share the selectors of plan-model.mjs, not the renderer.
- The chart's Gantt view is roadmap A4: until then a 'gantt' chart draws a placeholder and push refuses it; the bar's view toggle
  is Board | Backlog and Options… has no swimlane (not built in A2 either), range, zoom, week-label or Gantt keys. Changing the
  plan in the bar clears `frozen`.
- Readability: the 0.8 scale rule also applies to the Backlog ("too many fields for the post width"); the editor shows a refused
  chart with a dashed "Refused on push: …" pill (editor DOM only). The image is `plan-<n>.png` with n = its image number; the error
  messages count the plan charts ("Plan chart 1: …").
- A frozen snapshot also keeps `today` (due colours and the footer date stay as they were), drops the tickets' `created` /
  `updated`, and keeps only the thread drafts' tags. Measured: 300 tickets with dates, dependencies and checklists ≈ 160 KB (the
  §11 target was 150 KB; acceptable, the snapshot is bounded by the 200-card / 80-row export limits in practice).
- Insert: without a plan for the draft's thread the toolbar opens the existing `planPick` dialog in an insert mode (title "Insert
  plan chart", Insert per plan, no Delete, "Create a plan for this thread" when the draft has a thread; components/plan/forms.jsx).
  The plan header's entry is a submenu "Insert into draft": "This view (<tab>)" (the tab's filters, filter text and the card
  fields, or for the Backlog the chart fields of the shown columns), then the saved views; disabled for the Gantt tab until A4.
- The chart bar changes its own node by position (`set`); `setPlanChart(id, patch)` exists for id addressing (C4). A pasted copy
  of a chart keeps its `id` (ids are unique on insert only); C4 should renumber duplicates when it addresses charts by id.
- Backlog: rows drag by their handle only (the cells hold selects and date inputs); Alt-drop sets the parent through
  `plan.tickets.update {parent}`; a parent row shows its summary estimate, dates and progress read-only; hidden columns and
  collapsed parents are `backlogHidden` / `backlogCollapsed` in `localStorage` `daf-writer.plan.<planId>`.
- Smoke: one frozen Board chart (`dw` 900); the gantt chart comes with A4.

## 8. Automation / AI-agent commands

### 8.1 Descriptor shape (Phase 0, `src/plan/plan-commands.mjs`)

Identical to the automation layer's `define()` entries so Phase 4 registers them unchanged:

```js
{
  id: 'plan.tickets.move',                       // ^plan(\.[a-zA-Z]+)+$ ; MCP name = id with '.' → '_'
  title: 'Move tickets to a column',
  group: 'plan',
  risk: 'write',                                 // 'read' | 'write' | 'destructive'
  undo: 'own',                                   // 'own' (plan stack) | 'doc' (TipTap history) | 'none'
  needs: [],                                     // gate ids (PLAN_GATES, §8.2); agent-automation.md §3.7
  args: { type: 'object', required: ['planId', 'ticketIds', 'status'], additionalProperties: false,
          properties: { planId: ID, ticketIds: { type: 'array', items: REF, minItems: 1 }, status: COL,
                        beforeId: REF, afterId: REF, createTag: { type: 'boolean', default: false } } },
  result: { type: 'object', properties: { rev: { type: 'integer' } } },
  examples: [{ args: { planId: '3f1c…', ticketIds: ['#2'], status: 'done' } }],   // {args, dryRun?} pairs, as define() requires
  plan: (ctx, a) => moveTicket(ctx, a.ticketIds, a.status, a.beforeId, a.afterId, { createTag: a.createTag }),   // builder: → {plan, draftTags?, tags?} | {error: {code, message}}
}
```

`REF = {type: 'string', pattern: '^(#\\d+|[a-f0-9-]{36})$'}` (`#num` or uuid, resolved by `ticketRef`). `COL = {type: ['string', 'null']}`: a column id or the column's name (case-insensitive, resolved by `columnRef`; `null` = "No status"); unknown → `not_found`. Builder commands have `plan(ctx, a)`; imperative ones (`plan.open`, `plan.insertChart`, `plan.render`, …) have `run(ctx, a)` whose bodies live in `src/app/plans.js` because they touch the DOM. In Phase 4 the `define()` entries sit in `src/app/commands/plan.mjs` and reach `src/app/plans.js` through the automation layer's `ctx.plans`, so the catalogue stays importable by `node --test`; a builder registers as `plan` (dry run) plus `run` = `ctx.plans.dispatch` (own store and undo, agent-automation.md §3.1). A dry run of a builder command = call `plan()` and return the would-be plan and its `schedule()` without persisting.

### 8.2 `dispatch(id, args, {source: 'ui' | 'palette' | 'smoke' | 'agent:<name>'})` (`src/app/plans.js`)

1. Lookup → error `unknown_command`. 2. `#num`, column, unit, label, view, checklist-item and link refs are resolved by the reducers the builder calls (A1), which return `not_found`; a reducer's `not_found`, `already_exists`, `invalid_args` and `precondition_failed` stay envelope codes in step 5, every other code becomes `refused` (with the reducer's `data`, e.g. `unmapped_column`'s). 3. `ctx = planContext(args.planId)` (or `{plans}` for plan-level commands). 4. Gates: every `needs` entry of the descriptor → `{ok: false, error: {code: 'precondition_failed', data: {failed: [{gate, message, fix}]}}}` (agent-automation.md §3.2, §3.7). 5. Builder: `plan(ctx, args)`; `{error}` → return `{ok: false, error: {code: 'refused', message, data: {code}}}` with the reducer's code in `data.code` (the automation layer's form for a namespace rule, agent-automation.md §3.2); the UI toasts `error.message`. 6. Apply: push `{plan?, draftTags?}` previous values to the undo stack; store update; persist settings then plan (§4). 7. `syncCompleted`; `rev++`; notify subscribers (`plan.changed {planId, rev}`). 8. Return `{ok: true, result, rev}`.
**Gates** (`PLAN_GATES` in `plan-commands.mjs`, the agent-automation.md §3.7 shape `{subject: 'plan', test, message, fix}`, merged into its `GATES` in Phase 4): `plan.columnRoom` = fewer than 10 columns ("A plan has at most 10 columns", fix: remove a column first) for `plan.columns.add`; `plan.otherColumn` = more than one column ("A plan keeps at least one column", fix: add another column first) for `plan.columns.remove`. The `+ Column` button and the column Delete entries are disabled or hidden with the same functions (§6.3), so the UI never meets this error; agents get it with the fix.
UI code calls `dispatch` for every mutation (no direct reducer calls outside it); destructive UI actions confirm before calling (as `deleteDraft` does), except single-row removals in dialogs (§8.4). Schema validation of `args` arrives with the automation layer's `schema.mjs` (Phase 4); until then `dispatch` trusts the UI and the contract test exercises the examples.

### 8.3 Catalogue

`ID` = uuid pattern, `REF` as above, `DATE = ^\d{4}-\d{2}-\d{2}$`. `risk: 'read'` unless noted; `undo: 'own'` unless noted. Refusal codes below (`tag_taken`, `unmapped_column`, `bad_unit`, `cycle`, `parent_dep`, `exists`) are `data.code` of a `refused` error (§8.2); `needs` gates fail with `precondition_failed` (§8.2); `not_found` and `already_exists` are envelope codes. Every command is a precise edit (agent-automation.md §4.3 #11): one entry or one field set; a patch merges the keys it names.

- `plan.list` → `[{id, threadUrl, title, open, done, blocked, updated}]`
- `plan.get {planId | threadUrl, include?: ['schedule', 'cards', 'tree']}` → `{plan, schedule?, cards?, tree?}`
- `plan.create` (write) `{threadUrl, title?}` → `{planId}`; `already_exists` when the thread has one
- `plan.update` (write) `{planId, patch: {title?, calendar?: {workdays?, weekOne?}, autoSchedule?, doneColumn?: COL, estimateUnit?: unit id | name | 'd'}}` (`calendar` keys merge; holidays change through `plan.holidays.*`)
- `plan.holidays.add` (write) `{planId, date: DATE}` (kept sorted; a date already listed → `exists`); `plan.holidays.remove` (destructive) `{planId, date}`
- No command replaces a whole list (user decisions: a whole-list write can drop entries it did not mean to touch and hides what changed from undo and the audit log). Columns, units, labels, saved views, holidays, and a ticket's dependencies, labels, checklist items and links change one entry per call: `.add`, `.update`, `.move` are `write`; `.remove` is `destructive` (asks agents every call, §8.4), except the link removals `plan.deps.remove` and `plan.tickets.labels.remove`, which are `write`.
- `plan.columns.add` (write; needs `plan.columnRoom`) `{planId, column: {name, color?, tagId?, wip?}, beforeId?: COL}` → `{columnId}`; `tag_taken` when another column maps `tagId`, `not_found` for a tag id not in `settings.tags`
- `plan.columns.update` (write) `{planId, columnId: COL, patch: {name?, color?, tagId?: string|null, wip?: integer|null}}`
- `plan.columns.move` (write) `{planId, columnId: COL, beforeId?: COL | afterId?: COL}`
- `plan.columns.remove` (destructive; needs `plan.otherColumn`) `{planId, columnId: COL, moveTo?: COL}` → `{moved: n}`; §3.2 delete rule
- `plan.units.add` (write) `{planId, unit: {name, daysPer}}` → `{unitId}`; `plan.units.update` (write) `{planId, unitId, patch: {name?, daysPer?}}`; both refused `bad_unit` for `daysPer ≤ 0`, an empty or duplicate name or `d`; `plan.units.remove` (destructive) `{planId, unitId}` → `{converted: n}`: its estimates become days (§3.2) and a default `estimateUnit` falls back to `d`. `unitId` = id or name (`unitRef`)
- `plan.delete` (destructive) `{planId}` → trash; the confirm text (UI) and the result (agents) report how many drafts embed it (`chartRefs` over every draft loaded once via `api.drafts.load`)
- `plan.tickets.create` (write) `{planId, ticket: {title, status?: COL, priority?, labels?: [name|id], estimate?, unit?: name|id, start?, end?, days?, milestone?, parent?: REF, deps?: [{on: REF, type?, lag?}], checklist?: [string|{text, done}], draftId?, urls?, description?}, beforeId?: REF}` → `{ticketId, num}` (`end` wins over `days`; `days` counts working days)
- `plan.tickets.update` (write) `{planId, ticketIds: [REF], patch: {title?, description?, priority?, estimate?, unit?, start?, end?, milestone?, progress?, parent?: REF|null, draftId?}}`: field sets only, applied to every named ticket; `start` and `end` are one field set (send both); `draftId` changes link/unlink (§3.1); status changes through `plan.tickets.move`; `deps`, `labels`, `checklist` and `urls` change through their per-entry commands below (user decision)
- `plan.tickets.move` (write) `{planId, ticketIds, status: COL, beforeId? | afterId?, createTag?: false}` — linked tickets and draft cards change `settings.draftTags` only. When the target column has no `tagId` and the call moves a linked ticket or draft card, agents get no popup: without `createTag` the whole call is refused and nothing changes (`unmapped_column`, `data: {columnId, name, color, tagId}`; `tagId` = `matchingTag` or null). With `createTag: true` it does what the popup's Create does (§3.1: uses `matchingTag` or adds a tag named and coloured like the column, maps the column, moves; one undo entry) → `{rev, tagId, created: boolean}`. An agent may instead map a tag first (`tags.add` in the automation layer, then `plan.columns.update {tagId}`) and retry
- `plan.tickets.delete` (destructive) `{planId, ticketIds}`
- `plan.tickets.reorder` (write) `{planId, ticketIds, beforeId? | afterId?}`: order only (Backlog row drag, Shift+↑/↓; added in A1, since `plan.tickets.move` needs a status)
- `plan.deps.add` (write) `{planId, from: REF, to: REF, type?, lag?}` → refused with `cycle` | `parent_dep` | `exists`; `plan.deps.update` (write) `{planId, from, to, patch: {type?, lag?}}` (`not_found` without that dependency); `plan.deps.remove` (write: it removes a link, agent-automation.md §5.2) `{planId, from, to}`
- `plan.tickets.labels.add` (write) `{planId, ticketIds: [REF], labelId, replace?: labelId}`: adds the label to every named ticket (one that has it is unchanged); `replace` takes that label off the same tickets in the same dispatch (the swimlane drop, §6.3); `plan.tickets.labels.remove` (write: a link) `{planId, ticketIds, labelId}`. `labelId` = id or name (`labelRef`)
- `plan.checklist.add` (write) `{planId, ticketId: REF, item: {text, done?}, beforeId?}` → `{itemId}`; `plan.checklist.update` (write) `{planId, ticketId, itemId, patch: {text?, done?}}`; `plan.checklist.move` (write) `{planId, ticketId, itemId, beforeId? | afterId?}`; `plan.checklist.remove` (destructive: text the user wrote) `{planId, ticketId, itemId}`
- `plan.urls.add` (write) `{planId, ticketId: REF, url: {url, title?}}` → `{urlId}`; `plan.urls.update` (write) `{planId, ticketId, urlId, patch: {url?, title?}}`; `plan.urls.remove` (destructive) `{planId, ticketId, urlId}`
- `plan.labels.add` (write) `{planId, label: {name, color?}}` → `{labelId}`; `plan.labels.update` (write) `{planId, labelId, patch: {name?, color?}}`; `plan.labels.remove` (destructive) `{planId, labelId}` → `{tickets: n}` (the label leaves every ticket; saved views and charts that list it ignore it). `labelId` = id or name (`labelRef`)
- `plan.views.add` (write) `{planId, view: {name, view, options?}}` → `{viewId}`; `plan.views.update` (write) `{planId, viewId, patch: {name?, view?, options?}}` (`options` keys merge into that view's options; a filter list such as `options.labels` is one value, agent-automation.md §4.3 #11); `plan.views.remove` (destructive) `{planId, viewId}`. `viewId` = id or name (`viewRef`)
- `plan.schedule {planId}` → `schedule()` result keyed by `#num` and id, plus `span`, `critical: [REF]`, `conflicts: [REF]`; `plan.schedule.apply` (write) `{planId}` → `autoScheduled`
- `plan.ready {planId}` → `[{id, num, title, status, start}]` (not done, no open blockers, in order)
- `plan.baseline.set` / `plan.baseline.clear` (write) `{planId}`
- `plan.import` (write) `{planId, tasks: [{tempId, title, parent?: tempId|REF, status?: COL, priority?, labels?, estimate?, unit?, start?, end?, days?, deps?: [{on: tempId|REF, type?, lag?}], milestone?, checklist?, description?}]}` → `{created: [{tempId, ticketId, num}]}`; all-or-nothing (a cycle or unknown ref refuses the whole import); the envelope's `dryRun` returns the resolved tickets and schedule without writing
- `plan.describe {planId, format: 'markdown' | 'mermaid' | 'json'}` → `{text}`
- `plan.insertChart` (write, `undo: 'doc'`) `{planId, view, options?, viewId?, at?: 'cursor' | 'end', frozen?: false}` → `{id, rev}`; one transaction (one Ctrl+Z); `viewId` copies that saved view's options at insert time (no live link)
- `plan.chart.set` (write, `undo: 'doc'`) `{id, patch: {view?, options?, dw?, planId?, frozen?: boolean}}` (`options` keys merge, as in `plan.views.update`); `not_found` when no node carries `id`
- `plan.chart.list` → `[{id, planId, view, frozen: boolean, dw}]` for the open draft
- `plan.render {planId?, chartId?, view?, options?, width?: 320..4000, theme?}` → `{png: base64, width, height}` via `rasterizePlanChart` (an agent sees what it built)
- `plan.open` (write, `undo: 'none'`) `{planId, tab?}`; `plan.close` (agents never change `lastView`, §6.1)
- `plan.undo` / `plan.redo` (write) `{planId}`
- `drafts.setTag` (automation layer) stays the direct way to change a draft's tag; its card then shows in the column of its thread's plan that maps that tag (§3.1), else in "No status".

### 8.4 Approval and policy (consistent with the automation layer §5; nothing new invented)

Agents are not implemented yet: until Phase 4 every caller is `ui`, `palette` or `smoke`, and the only Phase 0 deliverable here is the correct `risk` on each descriptor (contract-tested, §5).

- `read`, `write`: run. Writes are one undo entry (`own`) or one undo step (`doc`); `plan.insertChart`/`plan.chart.set` honour the envelope's `ifRev` (`stale` when the draft changed) exactly like `doc.insert`, and do not confirm. `plan.tickets.move` with `createTag: true` stays `write` (it adds a tag and removes nothing); onto an unmapped column without it, the call fails with `unmapped_column` instead of asking (§8.3).
- `destructive` (`plan.delete`, `plan.tickets.delete`, `plan.columns.remove`, `plan.units.remove`, `plan.labels.remove`, `plan.views.remove`, `plan.holidays.remove`, `plan.checklist.remove`, `plan.urls.remove`; the rule is agent-automation.md §5.2: anything that can remove something the user made): UI source → the existing confirm wording (§6.2 Views, Labels…, Units…, §6.3, §6.6, header Delete plan), except that removing one holiday, checklist item or link in its dialog does not confirm (one row; Ctrl+Z restores it); agent source → **always asks** (user decision): the automation layer's agent request card (agent-automation.md §5.1: "Agent · <name> wants to delete 3 tickets in <plan>", Deny / Allow, 60 s countdown → `denied{timeout}`, a hidden window times out the same way), on every call, on every connection. There is no "Allow for this session" button and no remembered approval at any risk level; several deletes are approved together only by sending them as one `batch`, which asks once and lists every destructive step. All of them are trash-moves or undoable anyway. No token/`needs_confirmation` protocol is added: the executor already defines confirmation for every command family, and a second mechanism would diverge.
- A call whose gate fails (`plan.columns.add` at 10 columns, `plan.columns.remove` of the only column) returns `precondition_failed` with the fix before any ask (agent-automation.md §3.3 step 5).
- Nothing in `plan.*` touches the forum; `push.prepare` stays the only path and Submit stays the human's click.

### 8.5 Events and headless use

Events emitted through the plan store (in-process `plans.subscribe`; Phase 4 forwards them as automation-layer events): `plan.changed {planId, rev}`, `plan.opened {planId, tab}`, `plan.closed`. `plan.render` needs the renderer DOM but neither focus nor a visible window (the offscreen host is `position: fixed; left: -100000px`, as the smoke run already proves with `showInactive`); `plan.import`, `plan.schedule`, `plan.describe` need nothing visual. All of it works with the main window `show: false`.

## 9. Library choices

Survey of 2026-10-06 (npm registry, bundlephobia/bundlejs sizes, vendor docs and source; nothing installed), verified by a second pass. Rules applied: MIT/Apache/ISC licence, a release in the last 12 months, React 19 support, CSP-safe (no eval, no remote services), JavaScript-usable, and the bundle cost against the lines it saves (esbuild builds one minified IIFE, `package.json` "build", so every byte ships to every user).

| Need | Choice | Rejected (verified facts) |
|---|---|---|
| Dates | UTC day ordinals + working-day index in `dates.mjs` (~80 lines); labels via native `Intl.DateTimeFormat` | date-fns 4.4 / dayjs 1.11 (MIT; business-day helpers are Mon–Fri only, so per-plan workdays and holidays stay own code; no timezone handling wanted); `Temporal` (native in the Electron 44 renderer, absent from the Node 22.16 test runtime); `@js-temporal/polyfill` 0.5.1 (last release 2025-03, ~230 kB min) |
| Scheduling | own CPM/PDM `schedule.mjs` (~150 lines) | nothing MIT, small, with SS/FF/SF + lag + float |
| Gantt | own SVG via React (`ChartView`) over `gantt-layout.mjs` | SVAR React Gantt 2.7.3 (MIT core; `lag`, auto-scheduling, critical path, baselines, working-day calendar, markers and PNG/PDF export are PRO; own Willow theme); DHTMLX Gantt Community 10.0.3 (MIT since 10.x, not GPL; critical path, baselines, calendars, auto-scheduling, today markers, unscheduled tasks, multi-task drag and undo are PRO; export via the DHTMLX online service; imperative, ~600 kB+); Kibo UI Gantt (shadcn copy-in TSX; a timeline with no dependency links, critical path or baselines; adds 6 runtime deps); frappe-gantt 1.2.2 (MIT; FS-only string deps, no lag/baseline/critical path, imperative DOM + own CSS); gantt-task-react 0.3.9 (no release since 2022-07, React 18 peer; fork @wamra/gantt-task-react needs MUI); wx-react-gantt (GPLv3); jsgantt-improved 3.0 (no lag/CPM/baseline, table rendering); react-calendar-timeline (0.30 beta, no links); Bryntum, Syncfusion, gantt-schedule-timeline-calendar (commercial/licence key); mermaid gantt (static SVG, ~3 MB min; kept only as `describe` text output) |
| Kanban board | own `Kanban.jsx` + `Card.jsx` (per-plan columns, tag map, draft cards, bulk selection, swimlanes have no library equivalent) | @svar-ui/react-kanban 2.6.0 (MIT, maintained; owns its data model, DOM and theme, undo is PRO, and the export path would need a second renderer of the same board); Kibo UI / Dice UI / ReUI Kanban (shadcn copy-in TSX on the legacy dnd-kit; Dice and ReUI add `@base-ui/react` beside `radix-ui`; ReUI's full boards are paid) |
| Kanban / Backlog drag | pointer events in `drag.js` + `drag.mjs` (~150 lines; the `dragRow` pattern Sidebar.jsx:178-213, same model as the Gantt gestures) | @dnd-kit/react 0.5.0 (MIT, React 19, but pre-1.0 with breaking minors every ~2 months, 7 @dnd-kit packages + @preact/signals-core, ~102 kB min / 33 kB gz, ~118 kB with helpers; its keyboard moves are already own shortcuts in §6.7); @dnd-kit/core 6.3.1 + sortable (no release since 2024-12); @hello-pangea/dnd 18.0.1 (no release since 2025-02, ~100 kB, list-only); Pragmatic drag and drop 4.0 and @formkit/drag-and-drop 0.6 (native HTML5 drag model, a second model next to the pointer gestures; formkit's hook also owns the list state); interactjs 1.10.28 (~97 kB, imperative per-element API); @use-gesture/react (no release since 2024-03); react-aria-components (a second primitives library) |
| Backlog table | own table over `tree(plan)` (one-column sort, hidden-column set, expand/collapse: ~60 lines) | TanStack Table 9 (MIT, ~45 kB min; add if the Backlog grows grouping, multi-sort, column resizing or facets); TanStack Virtual 3 (no virtualisation below ~500 cards, §13; a virtualised list would also break the full-height export) |
| Date input | `<input type="date">` (native in Chromium 152) | shadcn calendar + popover / react-day-picker 10 (~60 kB for YYYY-MM-DD fields) |
| Text area | shadcn `textarea` via CLI (the only new UI component; shared with the flowchart plan's import dialog, added in roadmap Stage 1) | hand-written textarea (forbidden by §7b) |
| Icons | lucide (installed): `SquareKanban`, `ChartGantt`, `ListTodo`, `Milestone`, `Flame`, `Ban`, `FileText`, `CircleCheck`, `Tag` | — |
| Export | `html-to-image` `toBlob` (installed) + `react-dom` `createRoot`/`flushSync` | server-side renderers; the PRO/online exporters of SVAR and DHTMLX (not offline) |
| Validation | the automation layer's `schema.mjs` when it lands; until then `parsePlan` + contract test | ajv / zod |

No new runtime dependency (bundle impact 0 kB). CSP unchanged. JavaScript only. No candidate meets the Gantt must-haves (SS/FF/SF with lag, critical path, baseline, working-day calendar) under a free licence, and every drag library would replace only the Board/Backlog half of `drag.js` while the Gantt gestures keep the pointer code. Revisit @dnd-kit/react at 1.0 if screen-reader drag announcements become a requirement. The choices of all three plans in one place: `docs/plans/ui-libraries.md`.

## 10. Phased implementation plan

Order puts the user's headline (embedding a board in a draft) before the Gantt and makes the commands the spine from day one.

Roadmap (`docs/plans/roadmap.md`): Phase 0 = stage A1 (its main/preload part is Stage 1), Phase 1 = A2, Phase 2 = A3, Phase 3 = A4, Phase 4 = part of C4. Stage 1 builds the shell first: `fileFamily` with `api.plans.*`, `state.view` and the workspace host, the sidebar footer with both tabs, the Insert plan chart button (a stub until Phase 2), `gates.mjs`, `src/components/ui/textarea.jsx`, and the per-feature files the phases below write instead of the shared lists: palette entries in `src/app/tools-plan.js`, forms in `components/plan/forms.jsx` (`PLAN_FORMS`), the smoke charts in `src/app/samples/plan.js`. It also wires the call sites in actions.js (`flushPlans`, plans in `init`, focus return, `onKeyDown`, `toggleQuickTools`) to stubs in `src/app/plans.js`, so the phases fill those stubs instead of editing actions.js.

### Phase 0 — model, commands, storage (pure + IPC)
- Deliverable: `parsePlan`, reducers (incl. per-plan columns, the tag ↔ column map, estimate units and the per-entry sub-list reducers), selectors, scheduler, Gantt layout, command descriptors (destructive ones marked, `needs` set) with `PLAN_GATES`, and the plan file family, all green under `npm test`; the §3.7 fixture scheduled to the table.
- Files: `src/plan/dates.mjs`, `schedule.mjs`, `plan-model.mjs`, `gantt-layout.mjs`, `plan-commands.mjs`, `src/app/components/plan/drag.mjs`; the plans family in `main.js` and `preload.js` is roadmap Stage 1 (`fileFamily`, §4); `test/fixtures/plan-sample.json`; tests `test/dates`, `schedule`, `plan-model`, `gantt-layout`, `plan-commands`, `plan-drag`. `drafts-meta.js` and `DEFAULT_SETTINGS` are not touched.
- SPEC: §3 (plans file incl. `columns`, `doneColumn`, `units`), §4 (`api.plans.*`, `.bak`, trash).
- Size: ≈ 1 200 lines + 700 test lines; 3–4 days.

### Phase 1 — workspace and Board
- Deliverable: open a plan from the sidebar's Plans tab or a thread row, create/move/edit/delete tickets (the ticket dialog sends one command per change), column management (add up to 10, rename, recolour, reorder, map a tag, WIP, done column, delete with a target; one command per change), estimate units, draft cards and linking through the tag map incl. the create-matching-tag popup, selection + bulk, filters, saved views, keyboard set, undo incl. draft moves, relaunch restores `lastView`.
- Files: `src/app/store.js` (`planUi`), `src/app/plans.js` (store, `dispatch`, undo, `openPlan`/`closePlan` over `openWorkspace`/`closeWorkspace`, settings reactions, export/import file, the Stage 1 stubs filled), `components/plan/PlanPage.jsx`, `PlanHeader.jsx`, `Kanban.jsx`, `Card.jsx`, `TicketDialog.jsx`, `drag.js`, `components/plan/forms.jsx` (`ticket`, `planLabels`, `planCalendar`, `planColumns`, `planUnits`, `planPick`), `components/Sidebar.jsx` (thread row action + count), `components/SettingsDialog.jsx` (`deleteTag` confirm and note, §6.9), `src/app/tools-plan.js`. Done earlier in roadmap Stage 1: `store.js` `view`, the actions.js call sites (`refocusEditor`, `returnFocus`, `onKeyDown` guard + Ctrl+Alt+P, `init` ordering, `toggleQuickTools` guard, `flushPlans` in the save / push / beforeunload paths), `App.jsx`, the `SidebarNav` footer, the `Plan` group and `view` in the tool context, `src/components/ui/textarea.jsx`.
- Tests: Phase 0 suites; `tool-rank` unchanged; manual at 1280×720 and 1600×1000.
- SPEC: §7f "Plan workspace" (6.1–6.3, 6.6–6.9), §7 Sidebar (footer tabs, thread rows)/shortcuts, §7c entries, §7d (Ctrl+Tab no-op in plan view).
- Size: ≈ 1 650 lines; 5–6 days.

### Phase 2 — Backlog, chart node, export
- Deliverable: Backlog tab; `planChart` node with Kanban and Backlog views, live/frozen, chart bar, options; push exports it as PNG at the drawn width with the readability rules; smoke covers a frozen kanban chart.
- Files: `components/plan/Backlog.jsx`, `ChartView.jsx` (kanban + backlog renderers, palettes), `src/plan-chart.js` (node, NodeView, `parseChart`, `rasterizePlanChart`, `planSource`, `activeChart`), `src/extensions.js`, `src/doc-utils.mjs` (`replaceWhiteboards`, `chartRefs`), `src/export.js`, `components/board/PlanChartBar.jsx` and its mount in `App.jsx`, `src/app/plans.js` (`planSource` fill, insert helpers incl. the toolbar button's `insertPlanChartDialog`, delete safeguard), `src/app/samples/plan.js` (the toolbar and quick-tools buttons are roadmap Stage 1).
- Tests: `test/doc-utils.test.mjs` (+planChart numbering, `chartRefs`), `test/plan-chart.test.mjs` (`parseChart`); `npm run smoke` writes the kanban PNG.
- SPEC: §5 (`replaceWhiteboards`, export branch), §6e "Plan chart node" (§6d is the flowchart plan's), §7f Backlog.
- Size: ≈ 1 100 lines; 4 days.

### Phase 3 — Gantt
- Deliverable: Gantt tab with all §6.5 gestures, dependency drawing, zooms incl. fit and week numbers, critical path, conflicts, auto-schedule, baselines; Gantt view in the chart node and export with zoom fallback; smoke covers the fixture gantt.
- Files: `components/plan/Gantt.jsx`, `ChartView.jsx` (gantt renderer), `PlanHeader.jsx` (baseline/auto-schedule/calendar entries), `src/plan-chart.js` (gantt readability), `src/app/samples/plan.js`.
- Tests: `gantt-layout` suite extended for `hitTest` and fallback; acceptance: the §3.7 fixture shows A→C→D→M critical on screen; each gesture = one undo entry.
- SPEC: §7f Gantt, §6e gantt options and fallback.
- Size: ≈ 900 lines; 4 days.

### Phase 4 — agent exposure (depends on the automation layer plan: its Phases 0–2, and Phase 3 for `daf-agent`)
- Deliverable: `plan.*` registered through `define()` from `PLAN_COMMANDS` (builders) and `src/app/commands/plan.mjs` (imperative: open/close/insertChart/chart.set/render, bodies in `src/app/plans.js` through `ctx.plans`); `args` validated by `schema.mjs`; destructive `plan.*` go through the agent request card on every call (§8.4, no session approval); events forwarded; `app.capabilities` lists them; smoke script `test/smoke/plan-basic.json` (`plan.create → plan.import → plan.schedule → plan.insertChart → plan.render → plan.describe mermaid`).
- Files: `src/app/commands/plan.mjs`, contract test entries, SPEC §8 "Commands and agents" plan section.
- Tests: the automation layer's contract test picks up `examples`; `daf-agent call plan.ready {…}` returns JSON; two consecutive `plan.tickets.delete` calls from `agent:test` raise two asks; `plan.columns.add` on a plan with 10 columns returns `precondition_failed` naming `plan.columnRoom`; an `agent:test` `plan.tickets.move` of a linked ticket onto an unmapped column returns `unmapped_column` with no popup, and with `createTag: true` adds the tag and moves it.
- Size: ≈ 250 lines; 1–2 days.

## 11. Risks and mitigations

- **Two owners of status**: ruled out by derivation (§3.1): a linked ticket has no status of its own; the global tag owns it and the column is read through `column.tagId`; the only writers of `draftTags` are `setDraftTag` and `moveTicket`/`linkDraft` through `tagDraft`; a move onto an unmapped column either gets a tag first (the §3.1 popup, or `createTag` for agents) or changes nothing; it is never stored twice. Tested in `plan-model.test.mjs`.
- **Whole-list writes**: none exist (user decisions; precise edits, agent-automation.md §4.3 #11). Columns, units, labels, views, holidays, global tags and a ticket's dependencies, labels, checklist items and links change one entry per command naming one id, so a stale or partial list cannot drop entries, and every change is its own audit line (and, inside a plan, its own undo entry); draft-tag undo restores only the drafts a dispatch changed (§4).
- **UI and command checks drifting**: the column limits are `PLAN_GATES`, read by the controls and by `dispatch` (§8.2); refusals that depend on the arguments (`cycle`, `tag_taken`, `unmapped_column`) come from the reducers the UI also calls (`canDrop` is shared by the reducer, the drag hint and the popup).
- **Per-plan columns vs global tags drift**: columns copy names/colours once at seeding and never follow tag renames; the `Tag` glyph and tooltip on the column header name the tag it follows; a tag no column maps shows as a badge in "No status", so nothing disappears.
- **Done column drift**: `plan.doneColumn` is explicit; a missing/unknown value falls back to the last column; the header marks the done column.
- **Tag deleted or settings reset**: a column's `tagId` whose tag is missing from settings stays in the file and reads as unmapped; only explicit deletion in the tag manager clears it (`unmapTag`), so a one-off corrupt `settings.json` never remaps a plan.
- **Column delete loses placement**: the confirm names the target column and the counts; one dispatch = one undo entry restores the column and every ticket's status.
- **Estimate units**: estimates stay in the unit they were entered in; days are derived; removing a unit converts to days instead of dropping numbers.
- **Hidden editor steals focus/keys**: `refocusEditor`/`returnFocus` target `#plan-root` in plan view; `openPlan` blurs the editor, clears node selection and tool modes; the editor column is `inert`; document shortcuts return early in plan view.
- **Layout-dependent editor code**: the editor keeps layout (`visibility: hidden`, not `display: none`), so width probes, zoom and push work while a plan is open.
- **Lost update between plan writes and settings writes**: one `dispatch` chain, settings first then plan, both idempotent; failures toast and the next dispatch re-saves; `.bak` keeps the previous plan file.
- **Milestones and non-working days in CPM**: zero duration, half-open indexes and date normalisation are defined (§3.7) and fixture-tested.
- **Parents**: summaries derived; deps on parents refused; tree render from a flat `order`; swimlane drop uses `setParent` with cycle refusal.
- **Chart addressing by position**: nodes carry `id`; commands take `id`; `setPlanChart` finds the node per call.
- **Chart node selection**: pointerdown sets the NodeSelection itself (stopEvent would otherwise hide the click from ProseMirror); paste/drop pass through.
- **Raster size**: layout width, measured height and display width are defined (§7.3–7.4); refusals carry the chart number and a fix.
- **React root inside a NodeView**: `ignoreMutation: true`, `stopEvent`, `root.unmount()` in `destroy`; the raster root is created and unmounted per export; smoke renders two charts every run.
- **Snapshot size in undo history**: frozen snapshots are pruned (§3.5) and bounded by the ticket count; measured in Phase 2 with a 300-ticket plan (target < 150 KB per freeze).
- **Live chart whose plan is gone**: push fails with a named error; the NodeView shows a placeholder; freezing is always possible while the plan exists.
- **Keyboard space**: plan keys live on `#plan-root` only; Ctrl+Space/Tab/S and window zoom stay global; Ctrl+Alt+P is free today (actions.js:676-717).
- **Big plans**: O(n + deps) layout and scheduling; Board renders all cards (no virtualisation) — fine for a few hundred; at most 10 columns (+ "No status").
- **Agent deletes**: every destructive `plan.*` call asks (§8.4); the contract test keeps every `.delete` and `.remove` command `destructive` (except the link removals `plan.deps.remove` and `plan.tickets.labels.remove`), so a new delete cannot slip in as `write`.
- **Engineers mid-change**: nothing in `whiteboard.js`, `canvas.js` or `history.js` is edited; this plan imports their exports (`insertBoard`, `topLevelPos`, `resolveBg`, `contentWidth`, `edgeSpeed`, `make`, `withoutScroll`, `newId`-style ids) and adds two one-line changes in `doc-utils.mjs` / `export.js`.
- **Undo stack lost on close**: in memory by design; `.bak` and trash cover file-level mistakes; persistent plan history (history.js pattern) only if this bites.

## 12. Open questions for the user

Resolved on 2026-10-06 and folded into the body: per-plan columns (§3.1, §3.2, §6.3), estimate units with a required days conversion (§3.1, §3.2, §6.2), agent deletes always ask (§8.4), no new library (§9), a drop of a linked card on a column that follows no tag asks to create a matching tag or cancel (§3.1, §6.3; agents: `createTag`, §8.3), per-entry commands instead of whole-list setters (§5, §6.2, §6.3, §8.3), per-entry commands for a ticket's dependencies, labels, checklist and links with a ticket dialog that sends one command per change (§5, §6.6, §8.3), precise edits and gates shared with the UI (§8.2; agent-automation.md §4.3 #11, §3.7), the sidebar Plans tab and the toolbar button as entry points (§6.2, §7.1).

The five questions below were then settled by the user's rule "use each plan's stated default" (2026-10-06): no split view (Q1), one plan per thread (Q2), startup restores `lastView` (Q3), `weekOne` stays off until set (Q4), removing a thread keeps its plan in the "Without a thread" group (Q5).

1. Opening a draft from a card switches back to the editor. Is a side-by-side split (plan + editor, needs ≥ 1600 px) wanted instead?
2. One plan per thread is enforced. Do you need several plans per thread (e.g. per assignment)? The picker is the only extra cost.
3. Startup restores the last view (plan or editor). Prefer always starting in the editor?
4. Academic week numbering (`calendar.weekOne`, "Wk 3" labels): should new plans default `weekOne` to the thread year's first Monday, or stay off until set?
5. Removing a thread keeps its plan in the picker's "Without a thread" group. Should it instead offer to trash the plan?

## 13. Deliberately skipped (and when to add)

Assignees/comments/time tracking (single user); recurring tasks; resource levelling; cost; multiple calendars per plan; constraint dates (reserve `constraint?` on the ticket if asked); `plan.history {since}` change log (agents diff `plan.get` or follow `plan.changed`; add when an agent needs field-level diffs); persistent plan undo (add if the in-memory stack loses work); Board virtualisation (add above ~500 cards); exported chart auto-splitting (refusal with a message instead); CSV import/export (`describe json` + Import plan… cover backups); block ids on whiteboard/canvas nodes (the automation layer should give them the same `id` attr as `planChart` when it lands); schema validation of `dispatch` args before Phase 4; more than 10 columns per plan (user cap); drag-to-reorder column headers (Move left/right and the Columns… dialog cover it; add if reordering is frequent); `plan.labels.move` / `plan.views.move` / `plan.urls.move` (order of labels, saved views and links is creation order; add with a reorder UI); grouping several per-entry changes into one undo entry (add a grouped `dispatch` if the dialogs' one-entry-per-change undo annoys); following global tag renames in columns (columns are plan-owned after seeding); unit-to-unit conversion other than through days, and per-plan hours-per-day (a custom unit's `daysPer` covers it); "Allow for this session" or any remembered approval for agent deletes (dropped by user decision; `batch` approves several deletes in one ask); a drag-and-drop, Kanban, table or Gantt library (§9; revisit @dnd-kit/react at 1.0 if screen-reader drag announcements become a requirement, TanStack Table if the Backlog needs grouping or multi-sort).
