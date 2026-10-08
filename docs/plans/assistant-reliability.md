# Assistant reliability plan

Written 2026-10-06 after the "straighten the yes arrow" failure (wrong target, then a promise with no action) and the
`board_get` call that failed validation on `itemPath`. Scope: the in-app assistant (SPEC §7i, automation plan §13) on
Qwen3.5-9B Q4_K_M at 16 K. The model is not the main problem. The harness around it gives a 9B model too little to see,
too much to read, and no way to be measured. This plan fixes that in four small waves, each one implementer plus one
reviewer, with an eval that runs before and after each wave.

## 1. Diagnosis

Ordered by impact. Each entry: what the user sees, the cause, where.

1. **The model cannot look mid-turn.** Pictures reach it only on the user's own message (`assistant.js pictures()`). No
   tool returns a picture: `board.render` is kept out of every tool set because a tool result is text and its PNG would
   arrive as base64 text (`tool-sets.mjs:31`). After a read or a write the model works blind.
2. **Pictures carry no handles.** The attached picture is a plain render (`capture.js:36-50`). Nothing on it links "the
   yes arrow" to an item id, so the model guesses.
3. **Attachments hide the ids.** `attach.mjs itemLines` names items by label and type only, never by id. A flowchart
   canvas is attached as Mermaid, which has no item ids at all. So even when the user has selected the exact item, the
   model cannot address it without a second read, and the read is the problem below.
4. **Reads are raw and big.** `board.get` returns every item field, including `d` (SVG path text), `points`, `vw`, `vh`.
   One flowchart read can take a third of the 16 K context (`loop.js MAX_RESULT` 16 000 characters). `clipResult` cuts
   any non-`doc_get` answer in the middle of its JSON.
5. **Tool text is thin.** The model form of a tool is its title only (`tools-schema.mjs:8`); the `examples` every
   `define()` must carry are dropped; most arguments have no description. `itemPath` ("The id of a canvas item of the
   whiteboard at path") reads as "the item you mean" to a small model, which is exactly the failed call.
6. **Errors do not teach.** A validation failure is `args/itemPath/0 must match ^[A-Za-z0-9_-]{1,32}$`
   (`commands.js:87`). It names the pattern, not the purpose, and gives no working example.
7. **The rules are a paragraph about documents.** `TOOL_RULES` (`loop.js:26-38`) explains draft reads and paths. It has
   no board procedure (read the board, find the item, update it by id) and no "when unsure, look" step.
8. **A promise ends the turn.** The claim check (`context.mjs CLAIM_RE`) catches past tense ("I've changed"). "I'll
   straighten it" passes, and the turn ends with nothing done.
9. **Sampling works against copying.** Every request sends `presence_penalty: 1.5` (`runtime.js:9-10`). llama.cpp
   applies penalties over the last 64 tokens of the sequence, prompt included, so the tokens of the ids and labels at
   the end of a tool result or attachment are penalised in the very call that must copy them. Likely a cause of wrong
   ids and odd argument text. Not proven; the eval measures it.
10. **No tools on the Flowcharts page** (`VIEW_SETS.flows: []`), three on Plans. The library editor cannot be addressed
    by `board.*` at all (coverage plan §3.6).
11. **Nothing is measured.** Every change is judged by live use. There is no fixture, no scripted prompt set, no pass rate.
12. **Pictures are encoded on the CPU on every card** (`--no-mmproj-offload`), also on a 12 GB card, so each picture
    costs seconds before the first token.

## 2. Principles

- Resolve references in code, not in the model. Labels, picture numbers and the user's selection map to ids in the app.
- Show, then act. A picture with numbered marks and a legend is the model's map of the board.
- One short procedure, not a rulebook. Look, read, act, check.
- Every tool: one sentence of purpose, one example, every argument described. Within the 16 K budget.
- Measure first. The eval runs before and after each wave; a wave that lowers the pass rate is reverted.

## 3. Waves

Each wave: one implementer and one reviewer (Opus, xhigh), `npm run build`, `node --test`, one harness run, the eval.

### Wave 0: the eval

- `test/assistant-eval/`: a fixture draft (a flowchart canvas with a "yes" connector and a bent arrow, a whiteboard with
  three shapes, two paragraphs), a flowchart in the library, and 12 prompts with expected outcomes: the tool that must
  run with its key arguments (name, path, id or label), tools that must not run, and no reply that claims or promises
  an action without a call. Cases: open a draft by title; straighten the yes arrow; rename a shape; move a shape left
  of another; delete the selected item; add a heading; reword a paragraph; answer a question without tools; a request
  that needs `commands_describe`; one that needs the picture (a shape named only by position); one on the Flowcharts
  page; one in Read only mode.
- Runs the real loop against a real llama-server through the Electron harness (temp userData, window off-screen).
  Server, model and projector paths come from environment variables; the harness never reads `%APPDATA%/daf-writer`
  itself. Pointing the variables at the installed files is the user's call.
- Output: pass rate per prompt, tool calls made, tokens used, seconds per turn. Manual run (`npm run assistant:eval`),
  not part of `npm test`.
- 2026-10-06: 25 cases (flows-add-shape an expected fail until VIEW_SETS.flows offers wave 3's flow tools); `npm run assistant:matrix` tabulates runs in matrix.md.
- 2026-10-07: 30 cases. Stepped cases score the share of steps met (0 to 100 %, in result.md and the matrix with an average score): the journeys journey-three-places and journey-flowchart, the long tasks long-headings-bold and long-reorder, and annotate-scene (mark and label the four things of fixture/scene.json on the Week 5 whiteboard, then a two-sentence summary under it).
- 2026-10-07: eval set 4, 33 cases: annotate-valorant-lanes, annotate-rivals-zones and delegate-annotation (the user types in one post while the assistant annotates another) run on fixture copies of three of the user's own forum posts, with the annotations the user drew on two boards removed into fixture/structure-truth.json and fixture/iteration-truth.json.

### Wave 1: handles, reads, text (largest gain, smallest code)

**Built 2026-10-06**, with the user's addition at the go: a cycle guard (`context.mjs loopKind`: A B A B or A B C A B C, or one
tool called with 4 or more different arguments since the last successful change; the first time the call runs and its result
gets "You are going round in circles (calls: ...). Say what you have learned and what is missing, then make a different call
or ask the user.", the second time the turn stops with "Stopped: the assistant kept repeating itself."; the identical-call rule
stays). SPEC §7i and §8 describe what was built. Deviations from the list below:

- Procedure step 6 asks one short question when the target is ambiguous; `view_render` joins it in wave 2. The steps also say
  never to show ids, and keep the open-draft, deletion-card and batch rules.
- Promise check: "Let me know", "Let me explain" (also summarise, clarify, describe, walk) and quoted text are not promises; "I can
  do that" is one. It has its own once-a-turn flag beside the claim check, and the ask is "Do it now with a tool call, or say what
  stops you."
- Brief items carry `shape` for shapes and cut a label at 120 characters; a whiteboard's brief board is `{kind, w (drawn width), height, bg, items}`.
  `board.find` skips the words "a", "an", "the", "of", "on", "in", "to" and "and", and matches "arrow" or "line" to a connector, "picture" to an image, a
  shape kind's name ("Decision") and a connector's end labels ("arrow from start").
- Budgets: `MAX_SET` 9 000 (core + board 8 986). To fit, seven titles and several briefs were shortened (SPEC §8 Catalogue);
  property descriptions may be 90 characters (the required `itemPath` wording is 82). "e.g." is left out when the first
  example is `{}`; `doc.get`'s first example is now the outline.
- Validator messages use keyboard characters ("must be at least 0"), since the model now reads them with the teaching text.
- Known limit of the cycle guard: reading one tool with four different arguments and no write (doc_get block by block after a
  cut read) gets the circle note, and a fifth such read stops the turn. The eval shows whether the threshold needs raising.
- Found, not changed: a board write replaces its block in place, and rev.js `mapPath` maps a replaced atom as deleted, so a
  later `board_get` by path with the old `ifRev` answers `stale` again and again (reads do not refresh the rev). Fix candidate:
  treat a size-preserving replace that starts at the block as the same block.
- `test/assistant-eval/run.js` patches `SAMPLING.fast` / `.think` for its A/B; tool requests now take `presence_penalty` from
  `runtime.js sampling()`, so an eval run that wants 1.5 on tool requests must patch `sampling` too.

- `attach.mjs itemLines`: every line starts with the id, `- c81hd0q connector "yes" from k3j9x0a "Decision" to q2m1f8z
  "End"`. The flowchart attachment lists the items this way; Mermaid stays only when it fits the 2 000-character cap.
- `board.get`: `format: 'brief'` by default: id, type, label, rounded box, and for a connector its two ends (id and
  label), route, head and the number of points. `format: 'full'` returns what it returns now. `MAX_RESULT` to 8 000.
- `board.find {path, q}`: items whose label, type or shape matches the words, as brief lines. "The yes arrow" becomes
  one deterministic call.
- Error messages: `invalid_args` adds the argument's description and the command's first example:
  `itemPath is only for a canvas item inside a whiteboard; omit it for a canvas block. Example: {"path":[4]}`.
- Model-form tools: description = title, one sentence on when to use it, and `e.g. {first example}`; every argument
  described; `itemPath` reworded as above. `MAX_SET` raised to 9 000 characters if the board set needs it (about 2 500
  tokens).
- `TOOL_RULES` rewritten as a numbered procedure: 1 read the situation note and the attachment; 2 for a board, find the
  item (`board_find` or `board_get`) and act on its id; 3 for a draft, read the paths, then act; 4 one call at a time;
  5 after a write, read once to check; 6 when a target is ambiguous or visual, call `view_render` (wave 2) or ask.
- Promise check: a reply with "I'll", "I will", "Let me" or "I'm going to" and no call in the turn is asked once:
  "Do it now with a tool call." Same mechanism as `CLAIM_ASK`.
- Sampling: `presence_penalty` 0 on requests that carry tools, 1.5 kept for tool-less requests; the eval runs both
  settings on the same prompts and the plan records the result.

### Wave 1b: first-call success (built 2026-10-06)

User request: better tool descriptions, like the skill files written for coding agents. Evidence, the real eval on the wave 1
code (Qwen3.5-9B Fable, 7 of 13, `scratchpad/eval/fable-wave1`): the model reached for `canvas_edit` whenever a canvas or
whiteboard was involved (straighten-yes, delete-selected, ground-shapes); open-by-title's first two calls had wrong arguments
(`drafts_open` with a title, `drafts_list` with a thread title as `threadUrl`); in Read only it searched `commands_index` for a
way round instead of saying it cannot; move-valve moved Valve but not left of Pump; tag-via-describe needed 5 calls. And a
node-selected flowchart canvas got the editor set, without `board_find`, in the very case that needs it.

- Tool sets: a node-selected canvas, flowchart canvas, image or whiteboard block (ui.state gate `node.board`) gets the board set
  (`viewOf {nodeBoard}`).
- `board.items.update`: `route: 'straight'` without `points` drops a connector's waypoints (`patched`); the brief says so.
- `rev.js mapPath`: a step that replaces one token at the block with one (a board write replaces the atom, a block type change
  its opening token) keeps the block's path, so `board_get` by path after a board write is no longer `stale` (wave 1 caveat). A
  longer same-size replace that starts there (a paste over whole blocks) stays `stale`: it is a different block.
- Cycle guard: one tool with ever new arguments gets the note at the 5th and the stop at the 8th (4 and 5 before); cycles as
  before.
- Not-for lines (`define({notFor})`, model form "Not for: ..."): `canvas_edit`, `canvas_close`, `ui_select`, `commands_index`,
  `drafts_list` (and its `threadUrl` text), `drafts_open`, `doc_get`, `board_get`, `board_find`, `board_items_remove`. To stay
  within `MAX_SET` (core + board 8 981 of 9 000) the briefs that restated their titles went, the board path text and
  `commands.index`'s title got shorter, and ITEM_BRIEF lost the stroke fields.
- Playbooks (`src/app/assistant/playbooks.mjs`): ten short procedures with example calls (change, delete, move and rename a board
  item, open a draft, tag a draft, edit draft text, a picture question, Read only, Canvas Mode). At most two per message go into
  the situation note under "How to do this:", so they are in the first request; `commands.index {q}` finds the rest. Rule 1 of
  `TOOL_RULES` says to follow them. A playbook that changes things is never paired with picture-question or read-only, which
  say to call no tool (review: "Change the colour of the start shape to red" got both).
- Eval: tag-via-describe allows 5 calls; straighten-yes's stub sends `route: 'straight'` alone and gets no `commands_describe`
  (the board set holds the tool). `DAF_EVAL_SAMPLING` already wrapped `runtime.js sampling()`; checked: `{"presence_penalty":1.5}`
  reaches tool requests.
- Verified: build, `npm test`, the stub eval 13 of 13, the wave 1b harness. Not yet run on the real model (the GPU was busy):
  the next real eval shows whether the playbooks move the 7 of 13.
- Known limits: delete-selected's items attachment comes with "Selected: nothing" and the editor set (once the chat box has the
  focus, a whiteboard with selected items is no longer the active board, whiteboard.js `updateActive`), so its playbook tells
  the model to add `board_items_remove` with `commands_describe`. The board set has 19 characters to spare.

### Wave 1c: what the model gets first (built 2026-10-06)

User request: "it might be the harness being awful with initial provision of tools and runtime-context ... when sending a
message", learn from OpenCode's harness, and implement all fixes before testing models. Evidence, the real eval on the wave 1
code (`scratchpad/eval/gemma-wave1`, 1 of 13; `fable-wave1`, 7 of 13): Gemma 4 12B's first call is usually right (rename-pump: a
correct `board_items_update` first) but it never stops: after the success it reads, lists and adds unasked items up to the
8-call cap and ends with an empty reply; on the Flowcharts page it ignored the note's `flowchart "Level loop"` line and made
up tool names, which Fable answered from the note. The user message was the note, then the pill label glued to the words
("[Flowchart canvas]Straighten the yes arrow."), then the attachment, then the picture: the request sat in the middle.
Gemma's chat template (read from the GGUF header) renders a parameter from type, enum, items, properties, required and
nullable only, so `doc_insert.at`'s anyOf came out as type "" with no alternatives (it sent `"at":"[2]"`), an untyped enum
without its values, and after a tool response the model goes on inside the same turn.

OpenCode patterns adopted (sst/opencode, packages/opencode/src): one system prompt per model family chosen by the model id
(`session/prompt/anthropic.txt`, `gemini.txt`, `gpt.txt`, `default.txt`) → `src/app/assistant/prompts.mjs`, 'qwen' and 'gemma';
one structured text per tool (`tool/edit.txt`: purpose, what to do before calling, argument rules, what errors mean) → the
`guide` lines of `define()`.

- Message layout (`attach.mjs modelContent`, `context.mjs withNote`): the situation note (with its playbooks), the attachment
  blocks, the pictures' captions and pictures, the tool search note, then "Request: " and the words without the pills, last.
  Neighbouring text parts are joined (both templates glue text parts, Gemma's trims each). The chat shows the pills as before.
- Connector lines carry route and bends: `- y6b1v4z connector "yes" from d4q8n1x "Decision" to e9r3t6w "End", straight, 2
  bends` (none: ", ortho, no bends" or ", straight"), after the line's cut; `board_get`'s brief field `points` is now `bends`.
- No unions in the gemma model form: a union is its first branch's type with the alternatives in the description (`at`: "A
  block path such as [3], or one of start, end, cursor"), nullable gets ", or null", enums get a type (string, with a null in
  them as nullable; number, with the values in words), unions of required keys are dropped; `ui.zoom` lists its number first. The registry still validates the full schema; a union without words of its own now names its
  alternatives in the teaching message (`define.mjs unionText`).
- Stop rules: Qwen's rule 5 is "After a write that succeeded, reply to the user in one short sentence. Read again only when the
  user asked for more changes." (the stale read moved to rule 3); every tool result ends with " Calls left in this reply: N.";
  a successful change followed by 3 successful reads ends the turn with "Done: <the change's step title in the past tense>."
  as a plain reply (`context.mjs readsAfterWrite`, `doneReply`).
- Playbook situation-question: a question word with page, draft, thread, flowchart, plan, selected or open is answered from the
  note with no tool; in every mode; never paired with a change playbook.
- Prompts per family (`familyOf(settings.assistant.model)`: gemma12b → gemma, everything else → qwen, as main's sampling).
  Gemma's: shorter imperative steps, the note first, "When the request is done, reply in one sentence and make no more calls.",
  only what the user asked, no read after a write. Qwen's: today's with the new rule 5.
- Guides for doc_get, doc_find, doc_insert, doc_replace, doc_delete, board_get, board_find, board_items_update,
  board_items_add, board_items_remove, drafts_list, drafts_open and commands_describe. `MAX_SET` 10 000, `MAX_TOOL` 2 600, both
  families tested. To fit `board.items.add` (gemma 2 597): its Before line went into the brief, `ITEM_BRIEF.heads` names the
  common heads only, the canvas item's `items` is a plain array.
- An items attachment counts as board context: `viewOf {boardItems}` gives the board set and the note's "Selected:" line names
  the items from the attachment. The eval's delete-selected now expects `board_items_remove` with `commands_describe` in `never`.
- Eval: `DAF_EVAL_MODEL_ID` (qwen9b | fable9b | gemma12b) sets `settings.assistant.model` in the fixture profile (launch line,
  sampling, prompt family); the result header names it. `collect` strips the calls-left line before parsing a tool answer.

Deviations: the qwen model form keeps anyOf. llama.cpp b11433 builds Qwen3.5's tool-call grammar from the schema (the
qwen3_coder tool-arg rules in llama-common.dll), so one type there would forbid `"at": "end"` and `"tagId": null`; Gemma's
arguments are not held to the schema (the eval shows `names` sent as a string), so the collapse is safe for it alone. The test
asserts no anyOf / oneOf / type list in every gemma-form tool. capture.js keeps no copy of the last board selection: the
message's items attachment is that capture.

Verified: build, `npm test`, the stub eval 13 of 13 (`stub-1c`), the wave 1c harness (on screen). Not run on a real model:
the user runs the eval matrix next (`DAF_EVAL_MODEL_ID` per model).

Known limits: the read-after-write guard also ends a turn whose model reads three times to prepare a second asked-for change
(it gets "Done: ..." for the first; the user asks again). "Done: ..." comes from the command title ("changed one item of a
whiteboard or canvas"), not the item's label. Described tools are kept in the family form they were described in until the view
changes. Navigation is a write for the guard, so three reads after `drafts_open` also end the turn ("Done: opened a draft in
the editor."), also when the user asked a question about the draft just opened.

Review fixes (2026-10-06): the gemma form types enums that hold null or numbers (doc.format's marks reached the template as
type "" with no values); `ui.zoom` lists its number first; `doneReply` stops at the first colon or "and" ("selected a block or
board items and bring it into view" read badly) and a `ui.invoke` uses its step label (its title named ui_snapshot); Gemma's
step 4 adds "If none fits, commands_index lists more."

### Wave 2 (and 1d): sight (built 2026-10-06)

User requests: "lets implement all our fixes first before actually testing models" (this is the last code wave before the eval
matrix) and, for 1d, on the move-valve case: "seems like models dont have the information about the edges of the rectangle? so
the center of the rectangle is indeed technically to the left but not down and stuck together". Evidence (`fable-wave1`,
`qwen-wave1`): move-valve sent `board_items_update {id: v1x6m9q, patch: {x: 120}}` (or `{x: 200, y: 100}`) without reading any
box, since the attachment line said only `v1x6m9q shape rect "Valve"`; in straighten-yes nothing on the picture tied "the yes
arrow" to an id. SPEC §7i and §8 describe what was built.

- 1d boxes: every attachment item line carries its box after the line's cut, `- v1x6m9q shape rect "Valve" at 420,40 size 160x80`
  (a text without a measured height: `width 240`); a connector keeps its ends, route and bends. A long list keeps its first whole
  lines and ends with "... and N more" (`attach.mjs listBody`; a flowchart canvas's Mermaid goes first).
- 1d `board.items.place {path, itemPath?, id, relation, of, gap = 24, align = true}` (write, undo doc): code reads both boxes and
  sets x and y (`board.mjs placeAt`), and returns both boxes as stored. In the board set; the move-board-item playbook points at it;
  the eval's move-valve accepts it or `board_items_update`, scored on the stored x (`result.item.x` below 71; score.js now takes
  `{$any: [names]}` as a call name), and its stub calls place.
- 1d pills: a pill among the words stays as "[label]" in the Request line ("Request: Make [Whiteboard] bigger"); only the pills
  before the first word (the auto-attached selection) go.
- 1d stop guard: only `doc.*` and `board.*` changes count for the write-then-reads guard (`context.mjs guardWrite`); opening a draft
  or Canvas Mode, closing it, selecting, scrolling and zooming do not.
- Marks (`src/app/assistant/marks.mjs`, the geometry pure and tested in `test/assistant-marks.test.mjs`): a badge 22 px high at the
  picture's own scale (#d6336c, a white ring, a white bold number) inside each box's top-left corner and on a connector's routed
  path at t 0.5 (`polylinePoint`), drawn on the PNG after rasterizing (`createImageBitmap`, `OffscreenCanvas`, PNG again). Canvas,
  flowchart canvas, whiteboard and board-item selection attachments get the marked picture (an image does not), their lines in
  the legend form `1 v1x6m9q shape rect "Valve" at 420,40 size 160x80`; a selection's picture is the whole board, its selected
  items first in the legend, then "Other items on the board". The caption adds "The numbers on it are the legend's."
- `view.render {path?, itemPath?}` (`src/app/commands/render.mjs`; read, `headless: false`, in the editor and board sets): a board's
  marked picture, or the viewport through main's `webContents.capturePage` (`window.capture`, `ctx.lib.capturePage`), cropped,
  scaled to at most 1 280 px and marked per board, with the legend. The loop sends the legend as the tool message and the picture
  as a user message right after it ("Picture from view_render of the board at block [3]. The numbers on it are the legend's.");
  step line "Rendered the board" or "Rendered the view"; later turns get the step's summary only.
- Picture after a write: the turn's first successful `board.*` change is followed by that board's marked picture, "The board after
  your change. Check it against the request, then reply." and the legend, so the reply request carries it. Not in Read only; off
  with `settings.assistant.pictureAfterWrite` false (default true; Settings > Assistant "Show the assistant the board after each
  change").
- Projector on the GPU for Qwen and Fable at `gpuMiB >= 10000` (`runtime.js launchArgs`); below it or unknown,
  `--no-mmproj-offload` as before (the 8 GB baseline).
- Budget and text: `MAX_SET` 11 000 (core + board 10 835 qwen / 10 995 gemma; to fit, `board.get`, `board.find` and
  `board.items.update` lost their Before guide lines, and the two new tools describe `itemPath` in 43 characters). Both prompt
  families get "When a target is visual or ambiguous, call view_render and use the numbers on the picture." The change-board-item
  and move-board-item playbooks say that the picture's numbers are the attachment lines' numbers.
- novision: main drops the image parts, cuts the caption sentence from the text part before each and leaves out the loop's picture
  messages, so a novision server gets view_render's legend alone. Found on the way: since wave 1c joined neighbouring text parts,
  the old filter dropped the whole part before a picture, which held the situation note and the attachment blocks.

Deviations:

- A connector with a middle label gets its badge just past the label along the path (its estimated half width plus 14 px), not on
  the midpoint: in the first harness picture the badge hid "yes".
- The picture after a write follows the turn's first board change; a second board change in the same turn gets none (one a turn).
  Its text adds view.render's legend under the given sentence, so the numbers on it mean something.
- The view_render line goes into the system prompt only while `view_render` is offered (editor and board sets), so the other views
  never name a tool they lack.
- `batch` and `ui.invoke` do not count as changes for the stop guard (only `doc.*` and `board.*` ids do).
- The new examples and playbook calls use neutral ids (k3j9x0a, q2m1f8z), not the eval fixture's v1x6m9q and p8w2r5d.

Verified: build, `npm test` (281), the stub eval 13 of 13 (`stub-2`), the wave 2 harness (on screen; the marked pictures in
`scratchpad/wave2/`: `marks.png`, `marks-zoom.png`, `board.png`, `view.png`). Not run on a real model: the eval matrix is next.

Known limits: on a picture scaled well below 1x (a board wider than about 2 500 px) a connector badge may touch its label; items with
the same top-left corner get overlapping badges; `board.items.place` counts a canvas text item that was never written through
`board.*` as 0 high; the viewport legend lists the draft's boards only (not Canvas Mode's board or the library editor); the board
set has 5 characters left under `MAX_SET`.

As planned:

- `view.render {path?}` (read, `headless:false`): the page viewport, or one board by path, at most 1 280 px on the long
  side, with numbered marks (a small badge at each item's top-left corner, at a connector's midpoint) drawn on the PNG
  after rasterizing, and a legend `1 k3j9x0a shape "Start"`. The loop sends the picture to the model as the next
  user-role message (OpenAI-style servers take images in user messages only), after the tool result that holds the
  legend. One picture per call; counted in the context ring.
- The attached picture of a canvas or whiteboard gets the same marks and legend, so the user's own attachment already
  carries the handles.
- After the last board write of a turn, one marked picture of that board goes back automatically, so the model can see
  what it did before it answers (about 900 tokens at 1 280 px). Off in Read only mode.
- The projector runs on the GPU when the card has 10 GB or more (`gpuMiB >= 10000`, the same threshold as Fable's
  `-ot`), on the CPU otherwise. The 8 GB default stands.
- Harness: the marks are legible at 1 280 px (a zoomed screenshot in `scratchpad/`), the picture message is accepted by
  the server after a tool message, and a `novision` server gets the legend without the picture.

### Wave 2b: patterns from Figma's MCP, and the context (built 2026-10-07)

User decisions: section 9 below ("sure."), and on 2026-10-07 "can we kick the context limit up to 32k, also 1's fix yes, 2 yes"
(1 = trimming older tool results within a turn, 2 = one live picture per turn; the 32 K launch line came first, `runtime.js
launchArgs`), plus the stock Qwen MTP file as an option. SPEC §7i and §8 describe what was built.

- In-turn trimming (`context.mjs turnMessages`, `fullResults`, `KEEP_RESULTS` 2): each request sends the turn's last two tool
  results in full and the older ones as their step line's result line, the summary later turns get. Keyed by the tool message
  object, since the stub (and a server that sends no ids) gives every call the same id. The guards still run on the call keys; a
  repeated call whose result went down to its summary runs again instead of getting "You already called this ...".
- One live picture (same helper): from the message after the one being answered, only the last picture message keeps its
  `image_url` part; older ones keep their caption. The user's own attachment pictures are not touched.
- Sparse answers (`context.mjs clipResult`, `sparse`): a `board_get`, `board_find` or `doc_get` (JSON or outline) answer over the
  8 000-character cap keeps its first whole items, blocks or entries and adds `sparse: true`, `next` (ids, or paths) and `hint`
  ("Read one with board_find {"path":[4],"q":"<id>"}." / "Read one with doc_get {"path":[k]}."); `cut` is gone. `board.find`
  puts the item first when `q` is its id and is sparse itself past its 40 hits. `board.get`'s brief and `doc.get`'s errors line say
  so.
- Sizes (`marks.mjs sizeText`, `boardPicture` → `size`): view_render's result, its caption, the picture after a write and an
  attachment's caption carry "1280 x 568 of a 900 x 400 board" (the viewport: "... view", an image block: "... image"); main's
  novision caption cut matches the new caption.
- Playbooks as skills (`playbooks.mjs`): `{id, title, triggers, when: {kinds?, views?, permission?}, text}`; a "Before:" first line
  for change-board-item (close Canvas Mode), delete-board-item (`commands_describe` for `board_items_remove`) and tag-draft; a last
  "Check:" line in every one; the note shows "Title (playbook id)"; `commands.index {q}` finds a playbook by its id's words.
  change-board-item now also covers adding ("Change or add an item on a board", step 4 `board_items_add`, triggers add and draw),
  since `board_items_add` names it. open-draft: "When one title matches, open it without asking. Ask which one only when several
  match." The longest playbook is 939 characters.
- Tool text: `define.mjs` `guide.playbook` → "Playbook: <id>." on `board_items_add` (change-board-item), `batch` (edit-draft-text) and
  `canvas_edit` (canvas-mode).
- Qwen MTP (`assistant-main.js` `PINS.models.qwen9bMtp`): `unsloth/Qwen3.5-9B-MTP-GGUF` at `9716a63`, `Qwen3.5-9B-Q4_K_M.gguf`
  5 868 826 976 bytes, sha256 `e8dd9481...` (checked against the tree API on 2026-10-07), saved as `Qwen3.5-9B-MTP-Q4_K_M.gguf`,
  the Qwen projector and licence; `config` picks it with `mtp` on `qwen9b`, and `mtp` now applies to every model, so the launch line
  gets `--spec-type draft-mtp --spec-draft-n-max 2` (no `-md`, no `-ot`). Settings shows the MTP checkbox for Qwen with "Uses a 5.9
  GB model file"; status().missing, leftovers and install follow the pin as for Fable.

Deviations:

- "The third request with the first two results as summaries": with two kept in full, the request after the third call has the
  first result as a summary and the one after the fourth the first two; the harness checks both.
- Budget: core + board 10 829 / 10 989 of 11 000. To fit, `board.items.add`, `.update` and `.remove` use the short `itemPath`
  wording (the reads keep the long one), `board.find`'s brief is shorter and `canvas.edit`'s Not-for line drops "board_find and".
- `next` that cannot hold every id (a board of thousands of items) keeps the first ones and adds `more` with the count.

Verified: build, `npm test` (286), the wave 2b harness (on screen, `scratchpad/wave2b/harness.js`, 24 of 24). The stub eval was not
run (another agent owns `test/assistant-eval/` at the moment). Not run on a real model.

Known limits: on a server without vision, an older picture message of the turn that lost its image keeps its caption, so the model
reads a caption with no picture (the newest one is dropped whole, as before). Trimming changes earlier messages of the request, so
the server's prompt cache is reused only up to the first trimmed result. A loop note on a trimmed result goes with it.

### Wave 3: coverage

- `VIEW_SETS.flows`: `board.get`, `board.find`, `board.items.add`, `board.items.update`, `board.items.remove`, `view.render`
  with `{flowId}` addressing on `board.*` (coverage plan §3.6, wave 4), and `flow.library.list` / `flow.library.get`.
- `VIEW_SETS.plan` from the coverage plan §3.1 once `plan.mjs` exists (wave 3 there).
- The eval gains a prompt per new set.

### Wave 3 (flows) (built 2026-10-06)

User request: "when i have the flow chart canvas selected the spotlight search isnt giving useful tools", then more work in
parallel. Built as `src/app/commands/flow.mjs` (SPEC §8 Catalogue `flow.*`, coverage plan §3.6) instead of `{flowId}`
addressing on `board.*`, since another agent was editing board.mjs: 13 commands, `flow.library.list` / `.get` / `.create` /
`.rename` / `.delete`, `flow.find`, `flow.items.add` / `.update` / `.remove` / `.place`, `flow.layout`, `flow.insert`,
`flow.open`. Item writes go through `commitLibrary`, so each is one step of the record's undo stack and shows at once in the
library editor (FlowEditor already followed `flowSource`) and in every synced canvas; a write while the user drags on that
board is `busy`.

- `FLOW_VIEW_SET` (flow.mjs) is the intended `VIEW_SETS.flows`: list, get, find, add, update, remove, place, insert, layout.
  With the core 8 788 characters (qwen) and 8 964 (gemma), under 9 000 (test/flow-commands.test.mjs). To fit, the titles of
  find, update and remove dropped "library", place's text is short and the flowId reads "From flow_library_list". The
  orchestrator wires it into tool-sets.mjs and adds a `flow` line to `CATEGORIES` (the group is `board` until then).
- Deviations from the coverage plan: no `flow.present` gate (the executor's `subjectOf` reads no flow subject from the arguments;
  each command answers `not_found`), `flow.insert` synced only, rename and delete in place of `.update` and `.remove`.
  `removeFlow` gained `{ask: false}` so the agent card is the only confirm.
- Copied, not shared: board.mjs keeps `briefItem`, `findText`, `freshIds`, `checked`, `endWarnings`, `settle` and `mustHave`
  private, so flow.mjs has copies (marked); export them from board.mjs once wave 2 is done and delete the copies.
- Verified: build, `npm test` (281), the flow harness (`scratchpad/wave3-flows/harness.js`, 20 of 20, on screen).
- Known limits: `flow.layout` keeps a connector's fixed anchors, as the palette's Auto layout does, so an arrow anchored s to n
  runs diagonally after an LR layout. The eval case `flows-add-shape` (wave 2's, test/assistant-eval/prompts.json) still
  expects `board_items_add` with a flowId and `expectedFail`; once `VIEW_SETS.flows` is wired, it should expect
  `flow_items_add` and drop `expectedFail`.

### Connector ends (built 2026-10-07)

User observation (2026-10-07): "for the straighten arrow task, i observe that all runs were unable to correctly identify that one
side of the arrow is attached to the center of anther rectangle, and the pointy side is at the bottom of one, thus changes were
never quite correct". Two causes. The text never said where an arrow's ends sat: the attachment line and `board_get`'s brief named
the items only. And the picture was wrong: the eval fixture stores anchor names (`s`, `e`, `w`), which route.mjs routed to the
boxes' centres, so the yes arrow seemed to leave Decision's centre while its data said bottom.

- Ends in words (SPEC §7i Attachments, §8 `board.get`): `from d4q8n1x "Decision" (bottom) to e9r3t6w "End" (bottom), straight,
  2 bends`; a free end "(a point at 120,40)"; the brief's ends carry `side`.
- route.mjs routes an anchor name as its fraction (SPEC §6d), so the picture matches the words.
- `board.items.straighten {path, id}` and `flow.items.straighten {flowId, id}` (SPEC §8): route straight, no points, both ends
  on the sides that face each other (e/w when the horizontal gap between the boxes is the larger, else s/n). On the fixture
  that is Decision's right (e) to End's left (w). The change-board-item playbook sends "straighten" to it; `board_items_update` has a
  Not-for line pointing at it.
- Eval straighten-yes: `board_items_straighten` or an equivalent `board_items_update`, with route straight, no points and the
  facing anchors.
- Budgets: `MAX_SET` 11 500 (core + board 11 495 in the gemma form); the flows cap in test/flow-commands.test.mjs is 9 500 (core
  + flows 9 403), since the flow briefs could not absorb a new tool under 9 000. No `itemPath` on `board.items.straighten`.

### Tier B: background drafts (built 2026-10-07)

User requests: 2026-10-06 "even better if the assistant can work on a page that im not working in, in the background where i can
just check in on the progress a minute or so later and see it working n shi", and 2026-10-07 the delegate-annotation eval case
(working on one post while the assistant annotates another). Section 7 Tier B; SPEC §7i Background drafts and §8 Background drafts
describe what was built.

- Sessions (`src/app/assistant/sessions.js`): `sessionFor(draftId)` gives a hidden editor bound to that draft, made by the main
  editor's factory (`actions.js makeEditor`, split out of `mountEditor`) in a `.page` host inside `#sessions` (App.jsx, main column;
  `left: -20000px`, visibility hidden, never display none). Loaded from the drafts store with its history file, saved 800 ms after a
  change through `actions.js saveOther` (the open draft's save chain, file and history file), revisions of its own (`rev.js revs`,
  the old `recordRev` / `clearRevLog` / `mapPath` are the open draft's tracker), ended 5 minutes after its last command
  (`IDLE.ms`) or on handover. Never for the open draft; a session never saves while its draft is open.
- `draftId` on `doc.*`, `board.*`, `view.render`, `flow.insert` and `ui.select` (`DRAFT_ID`, and one sentence at the end of each
  brief). The executor routes a command with a `draftId` argument that needs `doc.open` or `view.editor`: `ctx.editor`,
  `ctx.state.draft` / `.rev`, the gate subjects of `doc.open`, `view.editor` and `node`, the path mapping of `ifRev` and the
  answer's `draftId` / `rev` are the session's; `board.active` and the Canvas Mode gates stay the open draft's. A batch works on
  one draft.
- Handover (`openDraft` → `handOver`): after the session's command in flight (a batch: all of it) and its last save, the main
  editor loads the session's document and its undo steps (the log as a history file, at least 50 kept), the session ends, later
  `draftId` commands go to the main editor. Undo: the session's history moves with the document, so Ctrl+Z undoes the assistant's
  writes one step at a time.
- Loop: `ifRev` per draft (`session.revs`), the after-write picture renders the written draft's board, no step Undo for a
  background write, `endTurn` clears the badges. Note line "Working in the background on: "<title>"". UI: the sidebar row's
  "Assistant" badge and the chat's `Working on "<title>"` line while a background write happened in the turn.
- Also: closing the window saves sessions first; deleting a draft drops its session unsaved; `drafts.setThread` / `unpush` patch
  a session's draft object.
- Budgets: `MAX_SET` 11 500 → 13 500 (core + board 13 224 in the gemma form; another job then took it to 13 700 for `board.fit`),
  `MAX_TOOL` 2 600 → 2 800 (board_items_add 2 761 gemma), the flows cap 9 500 → 9 700 (9 640). Core + editor 11 514 gemma.

Deviations: the sidebar shows "Assistant" (a spinner badge), not "Assistant working, 3 of 8" (no job mode yet). Conflicts cannot
arise: the user edits a draft only by opening it, which hands the session over first. The open-draft playbook (the tuning loop's)
does not mention `draftId` yet; it should gain "when the user says to keep working where they are, use draftId instead of
opening". The delegate-annotation stub script still opens Structure Analysis with `drafts_open`, so its view-stays step stays an
expected fail in the stub eval until that script uses `draftId`.

Verified: build, `npm test` (292), the Tier B harness (`scratchpad/tierb/harness.js`, window minimized, 30 of 30), the stub eval
(33 of 33; delegate-annotation 100 % with its view-stays step XFAIL, see above). Not run on a real model.

Known limits: a synced canvas written in a session records the open draft as the library write's origin (flows.js `origin`). The
`draft.changed` event does not fire for session writes. A theme change does not redraw a session's boards. `drafts.get` reads the
file, which lags a session's last change by up to 800 ms.

### Wave 4: settings (already queued, unchanged)

Context length select, the default thinking effort in Settings, the VRAM fit estimate with its plain warning.

## 4. Decisions for the user

1. `presence_penalty` 0 on tool requests: measured by the eval, kept if the pass rate does not fall. Default: yes.
2. Projector on the GPU at 10 GB or more. Default: yes.
3. An automatic picture after the last board write of a turn (about 900 tokens). Default: yes.
4. The eval reads the server and model through environment variables the user sets. Default: yes.

## 5. What this replaces

The queued "visual fix" job (view_render, pre-capture, promise nudge, connector fields) is waves 1 and 2 of this plan.
The settings job stays as wave 4. The flow and plan command backlog (assistant-coverage.md §3) stays; wave 3 takes the
view sets from it.

## 6. Jobs: consistent multi-step work

User goal (2026-10-06): "quite consistently gets the job done", e.g. annotating images. Consistency comes from fixed
pipelines where the model only perceives and names and code does placement, ordering and checking. Open-ended requests on
a 9B model stay at about 80 %; a fixed job can reach the mid-90s on its own eval.

- **Job mode** in the loop: a plan step first (the model lists the steps as JSON), a budget of about 50 calls, a ledger
  (the plan and the done list) that survives compaction, a progress line in the chat ("3 of 8 labels placed"), Stop,
  and "Undo job" (all its steps as one history group).
- **Annotate image** (the first job):
  1. The app renders the image at a known pixel size and sends it with the request.
  2. One grounding request with a forced JSON schema: `[{label, box: [x1, y1, x2, y2]}]`. Qwen3.5 inherits Qwen3-VL
     grounding (normalised coordinates; the eval's fixture image with known boxes confirms the convention and the hit rate
     before anything is built on it). The model names regions, nothing else.
  3. Code maps the boxes to board coordinates and places numbered markers or callouts with connectors: a free side per
     label, no overlaps, no model placement.
  4. The marked picture goes back; the model checks each label against its region and flags misses; code fixes or asks.
  5. One undo step for the whole job.
- Later jobs of the same shape: tidy a flowchart (`layout.mjs`, no model placement), caption images, number the steps on
  a screenshot, turn thread notes into a draft section.
- Weak link: step 2. Grounding of a 9B at Q4 on dense screenshots is unmeasured; the eval measures it first.

## 7. Background work

- **Tier A (cheap):** the assistant keeps working on the open draft while the user is on Plans, Flowcharts or Settings.
  Doc and board writes drop the `view.editor` gate where the editor only has to exist, not be shown (`doc.open` stays).
  Step lines show progress; back in the editor the changes are there. Not covered: the user editing another draft
  meanwhile (the editor holds one draft).
- **Tier B (real; built 2026-10-07 without job mode, section 3):** jobs on any draft by id without opening it. A hidden second TipTap editor per job in an offscreen
  div (node views still measure and rasterise), saved through the normal save path; the sidebar row shows "Assistant
  working, 3 of 8"; opening that draft hands the job over to the live editor, which carries on. Conflicts: the user's
  edit wins, the job re-reads. The largest piece of this plan: 2 to 3 jobs.

## 8. Order

1. Wave 0 (eval, with a grounding fixture). 2. Wave 1. 3. Wave 2 plus the grounding request. 4. Annotate-image job,
Tier A, job mode. 5. Tier B. 6. Waves 3 and 4.

The model choice between Qwen3.5-9B, Defiant Fable 9B and Gemma 4 12B (automation plan §11 Q22) is settled by the eval matrix.
Since 2026-10-07 the Gemma slot is the stock model, Gemma 4 12B from `unsloth/gemma-4-12b-it-GGUF` (user decision, automation plan §11 Q22).

## 9. Wave 2b (queued 2026-10-06, after wave 2; built 2026-10-07, section 3): patterns from Figma's MCP

Agreed by the user ("sure."). Source: the Figma MCP's own tool text and skill index, read in session.

1. Sparse answers, never cuts: a `board_get` or `doc_get` answer that would pass the size cap returns the ids or block paths
   to read next (per board or block), as Figma's `get_design_context` flags a response sparse and names the child ids.
2. Sizes on every picture result: rendered width and height and the board's own size, so the model can ask for one board
   sharper (`view_render {path}`) instead of the whole view.
3. Playbooks as skills: each description is a trigger phrase list plus its prerequisite ("before board_items_add, read
   change-board-item"); the tool text of the risky tools (`board_items_add`, `batch`, `canvas_edit`) names its playbook.
   Auto-routing stays (a 9B should not spend a call fetching).
4. A Verification line in every playbook: what a fail looks like, checked against the after-write picture.
5. open-draft playbook: one matching title means open it without asking (the 1c eval: Qwen asked "Shall I open that one?"
   with one match and made no call).

## Eval set 5: vague requests (2026-10-07)

The user asked for tests of vaguer instructions, "like asking the assistant to simply help 'annotate the rest of the maps'".
Three stepped cases on copies of the user's posts, each scored against the user's own marks that the copy lacks
(test/assistant-eval/prompts.json, fixture/overwatch-truth.json, fixture/rivals-finish-truth.json; built by a one-off script):

| Case | Request | Setup | Steps |
|---|---|---|---|
| vague-annotate-rest | "help me annotate the rest of the maps" | Structure Analysis, Overwatch annotated, Valorant blank; nothing selected, caret at the end | annotate-valorant-lanes's nine, Overwatch unchanged, marks red, notes on the user's yellow |
| vague-same-for-others | "do the same for the other maps" | trimmed copy, the upper Overwatch picture marked, the lower one's 13 marks removed; board selected | per map the centre box and the share of lanes (inside canvas item 4agxi9n, artboard px), the rest unchanged, marks red |
| vague-finish-board | "finish annotating this board" | trimmed Rivals copy, green anchors kept, the red circles its notes name removed; board selected | corridor encounter and chokepoint circled, notes and green marks unchanged |

Scorer additions (score.js): `lines` (share of a group drawn), `colour` (share of added marks in a hue), `noteBg` (share of added
notes on a background), `same` (an exemplar board unchanged, the app's own text heights and image data ignored), truth.canvas
(marks inside a canvas item). Stub: 3 of 3 at 100%; vague-annotate-rest's stubWrong (blue marks, plain notes) 83%. Full stub
36 of 36.

Found and fixed on the way: a bare id for `itemPath` was refused although its description says "as its id" (commands.js now wraps
a bare string where an array is wanted); new items on a blank board now match the page's other boards (item-style.mjs
`pageItems`), so "the rest of the maps" get the page's red without the model naming a colour; the stub server counted a picture's
base64 as text (hundreds of thousands of tokens, the context ring red in the eval windows), now about 1,000 tokens a picture.
The runner takes DAF_EVAL_PROVIDER=google (key in GEMINI_API_KEY or DAF_EVAL_KEY) to run the cases on Gemini. Not yet run on a
real model.

## Local models off (2026-10-07)

The user: "i plan to abandon local llm usage, just stick to google api now. comment out all the code for local llm stuff". The
assistant runs on Google AI only (SPEC §7i, first paragraph). The local llama.cpp runtime is commented out, not deleted, marked
"LOCAL LLM" (src/assistant-main.js keeps the old module whole in a comment at its end). Tests 288 (the 10 llama-server runtime tests
commented out), stub eval 36 of 36. The downloaded model files under the app's assistant folder stay on disk.
