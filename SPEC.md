# EasyWriter — build spec

Desktop editor (Electron) for writing Digital Academy Forum (daf.staffs.ac.uk) development-thread posts
with Word-like formatting, local drafts, font presets, and "whiteboard" sections that get flattened to
images, then pushed into the forum's own reply editor.

This file is the contract between modules. Follow names, signatures and data shapes exactly.

---------------------------------------------------------------------------------------------------
## 1. Forum facts (verified live on 2026-10-04 — do not guess beyond these)

- Software: Invision Community 5 (cloud). Editor = TipTap/ProseMirror. The TipTap Editor instance is
  `pmEl.editor` where `pmEl = form.querySelector('.ProseMirror')`.
- Reply form: `textarea[data-role="contentEditor"]` (name `topic_comment_<topicId>`); the form is `textarea.form`.
  Editor starts collapsed: `.ProseMirror` does not exist until `.ipsComposeArea_dummy` inside the form is clicked.
  After click, poll until `form.querySelector('.ProseMirror')?.editor` exists (takes ~1-3 s).
- Image upload (verified live 2026-10-05): the uploader element `form.querySelector('[data-ipsuploader]')` (exists once
  the editor is open) handles a DOM event `injectFile` whose `.data = {file: File, data: {ready(content, info), error()}}`.
  After the upload, the insertable controller calls `ready(content, info)`: `content` is the insert HTML
  (`<img data-fileid="…" src="//media…" class="ipsImage ipsImage_thumbnailed">`), `info.fileID` the attachment id.
  Do NOT use `editor.commands.injectAttachments` (its in-editor placeholder stalled on "Uploading Attachment…" in a
  real push even though the upload finished). Max file size 20 971 520 bytes.
- `ipsAttachment` attrs: nativeWidth, nativeHeight, attachmentType ('image'|'video'|'file'|...), fileId,
  attachmentSrc, fullImage, attachmentLink, attachmentTitle, fileExtension, alignStyle
  ('left'|'right'|'inline'; anything else = block), attachmentWidth ('fullwidth'|'automatic'|number = custom px),
  alt, videoPreviewTime, mimeType.
- HTML the forum editor accepts (round-trip verified with `editor.commands.setContent(html)` → `getHTML()`):
  - `<h1>`…`<h6>`, `<p>`; alignment via `style="text-align: center;"` (left|center|right|justify)
  - `<strong> <em> <u> <s> <sub> <sup> <code> <a href="...">`
  - Font size: `<span data-ips-font-size="N">`, N ∈ 80, 90, 100, 125, 150, 175, 200 (percent of base)
  - Text colour: `<span data-i-color="K">`, K ∈ root (Default), soft (Faint), hard (Prominent), red, orange,
    yellow, green, blue, indigo, violet. No arbitrary colours.
  - Highlight: `<mark data-i-background-color="K">`, K ∈ red, orange, yellow, green, blue, indigo, violet
  - Font family: `<span style="font-family: NAME">`; forum keeps only these (label → css name):
    Helvetica, Arial, Arial Black, Verdana, Tahoma, Trebuchet MS, Impact, Gill Sans, Times New Roman,
    Georgia, Palatino, Baskerville, "Andalé Mono" → `Andale Mono`, Courier, Monaco, Bradley Hand,
    Brush Script MT, Luminari. Quote multi-word names: `font-family: "Times New Roman"`. Unknown fonts are dropped.
  - `<blockquote><p>…</p></blockquote>`, `<pre><code>…</code></pre>`, `<hr>`, `<ul>/<ol>` with `<li><p>…</p></li>`,
    `<table><tbody><tr><th><p>…</p></th><td><p>…</p></td></tr></tbody></table>`
  - Box (titled panel):
    `<div class="ipsRichTextBox ipsRichTextBox--alwaysopen"><div class="ipsRichTextBox__title"><p>TITLE</p></div><i-richtext-box-content class="ipsRichText"><p>BODY</p></i-richtext-box-content></div>`
  - NOT supported: arbitrary px font sizes, arbitrary colours, absolute positioning, text boxes → whiteboard.
- Post content width: max 1454 CSS px (main column `min(100% - 80px, 1500px)` minus ~22 px padding each side).
  Default `forumWidth` = 1454.
- Forum dark theme (the user's): page bg `#21212a`, post bg `#303039`, body text `#c5c6d0`, headings/links `#ffffff`.
  Base font `system-ui, Helvetica, Arial, sans-serif`, 16px, line-height 1.8. `p` margin 1em 0.
  Headings bold, white: h1 3em/1.1 (margin 0 0 14.5px), h2 2.2em/1.1, h3 1.8em/1.1, h4 1.5em/1.8, h5 1.2em/1.8,
  h6 1em/1.8 (margins 14.5px 0). Colours: red `#e05252`, orange `#e09952`, yellow `#e0c952`, green `#62d926`,
  blue `#3d99f5`, indigo `#9c6ef7`, violet `#e052e0`, soft `#a3a6b8`, hard `#ffffff`, root = inherit.
  Highlight = same hue at 25 % alpha background, text colour inherit, padding 3px 0.
  Blockquote: bg `#3a3b46`, border-left 3px solid `#4c4d55`, padding 20px, text `#a3a6b8`.
  Code block: bg `#3a3b46`, border-left 3px solid `#4c4d55`, padding 18px, monospace 0.9em.
  Inline code: bg `#45465a`, padding 3px 8px, radius 4px, `ui-monospace, "Cascadia Code", monospace`.
  Table: border 1px solid `#6b6d80`, th bg `#45465a` weight 600, cell padding 11px. hr: 1px `#c5c6d0`, margin 1em 0.
  List: margin-top 1em, padding-left 1.5em.
  Light theme (alternative): page `#f2f2f5`, post `#ffffff`, text `#333340`, headings `#111111`, quote/code bg `#f0f0f4`,
  borders `#d0d0da`, th bg `#ececf2`, soft `#6b6d80`, hard `#000000`.
- Login: `/login/` redirects to a cross-origin SSO. The user completes it in an embedded window.
  Logged in ⇔ `ips.getSetting('memberID') > 0` on any forum page. Profile link: `a[href*="/profile/<memberID>-"]`
  (e.g. `https://daf.staffs.ac.uk/profile/8779-kelvin-chung/`). Display name: profile link text, or
  `ips.getSetting('memberName')` if present.
- Thread discovery:
  - GET `<profileUrl>content/?type=forums_topic` (same-origin fetch with credentials). Rows: `li.ipsData__item`.
    Topic link = first `a[href*="/topic/"]` in the row whose trimmed text is not "Go to first unread post";
    strip query/hash from href. Next page: `link[rel="next"]` or `a[rel="next"]` href (follow max 10 pages).
  - For each topic URL GET the page; parse every `script[type="application/ld+json"]` (value may be an object,
    array, or have `@graph`), find `@type === 'BreadcrumbList'`; `names = itemListElement.map(i => i.item?.name ?? i.name)`.
    Example: ["Assessment Forums","2026/27 (Stoke)","Level 6","GDEV60026 Multiplayer Level Design","Development Thread","Ming Hei, Chung (Kelvin) - c012488o"].
    `subject = names[len-3]`, `forum = names[len-2]`, `title = names[len-1]`, `year = names[1] ?? ''`.
  - The user has ~13+ topics; fetch topic pages with concurrency 4.

---------------------------------------------------------------------------------------------------
## 2. Stack and files

Electron + plain JS (no TypeScript). Main process CommonJS. Renderer: ESM + JSX (React 19, shadcn/ui, §7b) bundled by esbuild
to `dist/renderer.js` (IIFE); Tailwind CSS v4 compiles `src/app.css` to `dist/app.css`. Installed deps: `@tiptap/core @tiptap/pm
@tiptap/starter-kit @tiptap/extension-text-align @tiptap/extension-subscript @tiptap/extension-superscript @tiptap/extension-table
html-to-image @dagrejs/dagre @tiptap/markdown` (dagre: flowchart auto-layout, §6d Formats; markdown: command content and
`doc.get`, §8) plus the §7b UI deps, dev: `electron esbuild tailwindcss @tailwindcss/cli`.
TipTap is v3 — read `node_modules/@tiptap/*/package.json` + `dist/index.d.ts` before using an API
(v3: StarterKit includes Link + Underline + UndoRedo; `@tiptap/extension-table` exports `Table, TableRow, TableCell, TableHeader`).

| File | Owner (build stage) | Purpose |
|---|---|---|
| package.json | done | scripts: build, start, smoke, smoke:agent, test |
| main.js | main | main process: windows, IPC, storage, forum session, smoke mode |
| preload.js | main | `contextBridge.exposeInMainWorld('api', …)` |
| src/github-sync.js | main | GitHub backup (§4b): device-flow login, the REST API calls, the per-file merge, the push timer and the close question |
| src/forum-inject.js | main | CommonJS. `buildPushScript(payload)`, `STATUS_SCRIPT`, `DISCOVER_SCRIPT` (JS source strings run in forum pages) |
| src/extensions.js | editor | TipTap extensions + `applyPreset` (the constants come from src/format.mjs and are re-exported) |
| src/doc-utils.mjs | editor | pure JSON transforms (no imports) — unit tested in Node |
| src/format.mjs | editor | pure, no imports: the forum's formatting values (`FONT_SIZES`, `TEXT_COLORS`, `HIGHLIGHTS`, `FONTS`) and `presetChain(chain, preset)`; extensions.js re-exports the values, the command catalogue imports them |
| src/export.js | editor | `buildPayload(editor, settings)` |
| src/whiteboard.js | whiteboard | `Board` surface, Whiteboard node + NodeView, paste/drop plugin, rasterizer |
| src/canvas.js | canvas | Smart canvas node, document NodeView, in-place canvas editing (§6b) |
| index.html, src/main.jsx, src/app/, src/app.css, src/page.css, src/components/ui/, components.json, jsconfig.json | ui | UI shell (§7, §7b), toolbar, sidebar, dialogs, autosave, push flow, `window.__smoke` |
| src/app/commands.js, src/app/commands/*.mjs, src/app/schema.mjs, src/app/digest.mjs, src/app/rev.js, src/doc-path.mjs, src/app/components/AgentAsk.jsx | agents | command registry, executor, agent request card (§8) |
| src/assistant-main.js, src/assistant/runtime.js, src/app/assistant/ (assistant.js, loop.js, Chat.jsx, panel.mjs) | assistant | local assistant: llama-server lifecycle in main, the chat button, panel, install dialog and tool loop (§7i) |
| src/computer-main.js, src/app/commands/computer.mjs, src/app/assistant/BackgroundPane.jsx | assistant | computer use: screenshots and mouse and keyboard input for the user's window and the offscreen background window, and the pane that shows it (§7i Computer use) |
| test/*.test.mjs / *.test.js | integrate | `node --test test/` |
| test/assistant-eval/ (run.js, score.js, prompts.json, fixture/) | assistant | manual assistant eval (docs/plans/assistant-reliability.md §3 Wave 0), never part of `npm test`: `npm run assistant:eval [-- <run name>]` types each case into the real chat panel (temp userData, window off-screen) against llama-server (`DAF_EVAL_SERVER` / `DAF_EVAL_MODEL` / `DAF_EVAL_MMPROJ`, or `DAF_EVAL_URL`) or a stub (`DAF_EVAL_STUB=1`), scores the calls and replies, writes `result.md` and `result.json` |

---------------------------------------------------------------------------------------------------
## 3. Data model

`settings.json` in `app.getPath('userData')`:
```json
{
  "forumWidth": 1454,
  "theme": "dark",
  "baseFont": "",
  "baseSize": 100,
  "presets": [
    {"id":"p1","name":"Key term","fontFamily":"","size":100,"color":"blue","highlight":"","bold":true,"italic":false,"underline":false},
    {"id":"p2","name":"Caption","fontFamily":"","size":90,"color":"soft","highlight":"","bold":false,"italic":true,"underline":false},
    {"id":"p3","name":"Highlight","fontFamily":"","size":100,"color":"root","highlight":"yellow","bold":false,"italic":false,"underline":false},
    {"id":"p4","name":"Statement","fontFamily":"","size":150,"color":"hard","highlight":"","bold":true,"italic":false,"underline":false}
  ],
  "threads": [{"url":"https://daf.staffs.ac.uk/topic/88136-…/","title":"…","subject":"GDEV60026 Multiplayer Level Design","year":"2026/27 (Stoke)","forum":"Development Thread"}],
  "selectedThread": null,
  "lastDraftId": null,
  "historyLimit": 50
}
```
`baseFont` "" = forum default; otherwise a css font name from FONTS. `size` 100 = no size mark. `color` "root" = no colour mark.
`highlight` "" = none. `fontFamily` "" = none.
`shapeFavourites` ([ref]: the shape list's Favourites in order) and `shapeOrder` ({basic?, flow?, container?, prefabs?: [ref]}: a
section's order, written once the user reorders it); ref = `kind:<kind>` | `prefab:<id>`; a missing key = none / registry order (§6g).
`assistant` (the local assistant, §7i; docs/plans/agent-automation.md §13.2): `{installed, backend, serverPath, modelPath,
mmprojPath, serverUrl, warmAtStart, sleepMinutes, idleUnloadMinutes, step, panel, thinking}`, default `{installed: false, backend: 'auto',
serverPath: '', modelPath: '', mmprojPath: '', serverUrl: '', warmAtStart: true, sleepMinutes: 10, idleUnloadMinutes: 30, step: 0}`
(`panel` missing = null). `installed` doubles as enabled (false = nothing runs; the renderer saves it after a successful install,
main never does). `backend`: `auto` (from the GPU vendor) | `cuda` | `vulkan` | `cpu`. `serverPath` / `modelPath` / `mmprojPath`
replace the downloaded files (unchecked); `serverUrl` (http/https; optional `apiKey`, sent as the Bearer key; both are fields under
Advanced in Settings) is used as it is and nothing is started. `provider` (2026-10-07): `local` (default) | `google`; `google`
runs Gemini through Google AI's OpenAI-compatible endpoint `https://generativelanguage.googleapis.com/v1beta/openai` with
`googleKey` (Bearer; left out of `settings.get`, stored as plain text in settings.json like `apiKey`) and `googleModel` (default
`gemini-3.8-flash`): nothing starts here, `status()` is ready only with a key and names the model, the request carries `model`,
`tools`, `stream_options`, `max_tokens` 8192 and `reasoning_effort` (`low` without Think, since Gemini 3.8 Flash cannot turn
thinking off; with Think the `thinking` level low | medium | high, else medium) and no llama.cpp fields (no `chat_template_kwargs`,
samplers, `/props`); `done` reports `n_ctx` as the model's input limit (status().ctx, below). Each tool call keeps its `extra_content` (Gemini's thought signature) and the
loop sends it back with that call in the same turn (earlier turns replay calls without it). The prompt family is `qwen` (prompts.mjs
`familyOf(model, provider)`). Settings > Assistant puts "Runs on" (This computer | Google AI (Gemini)) first, with API key and Model
fields for Google, and hides the local model, backend, idle unload and Advanced rows then. `sleepMinutes`: llama-server's own idle sleep (0 = off); `idleUnloadMinutes`: main kills the server that long
after the last request (0 = never). `step`: the degrade step 0–3 main reached after an out-of-memory load (§7i). `panel`: the chat
panel's place `{x: 'left'|'right', dx, y: 'top'|'bottom', dy, w, h}` (CSS px; null = the default place, §7i). `thinking`: the chat panel's Thinking menu, `auto` (missing or unknown, such as
the old `off` = `auto`) | `low` | `medium` | `high` | `xhigh` | `max` (§7i; 2026-10-07, the user's list, Off removed since Auto
thinks only for solve, derive or prove requests). This computer's budgets: 1,024, 4,096, 8,192, 16,384, 32,768 tokens, cut to fit
the context; Google AI: Gemini levels low, medium, high, and high for `xhigh` and `max`. Each menu line names the active provider's
meaning. The stored object
replaces the default whole (top-level merge), so a renderer save spreads the current `settings.assistant`, read fresh with
`settings.get` (main may have moved `step`); main falls back per key.
`agent`: `{enabled: false}` (§5.3 of the automation plan, Settings > Local AI agents): stored, gates nothing until the agent
transport exists.

`assistant/` in userData (only the assistant writes there; Settings > Assistant > Delete removes the folder):
`llama-<build>-<backend>/` (the extracted llama.cpp zip(s): `llama-server.exe` anywhere under it), `models/Qwen3.5-9B-Q4_K_M.gguf`,
`models/Qwen3.5-9B-mmproj-BF16.gguf`, or the chosen model's files (§7i Main; Gemma 4 12B: `models/gemma-4-12b-it-Q4_K_M.gguf`,
`models/gemma-4-12B-mmproj-BF16.gguf`, with MTP `models/gemma-4-12B-it-MTP-Q8_0.gguf`) (any other `models/*.gguf`, e.g. the 4B's
`Qwen3.5-4B-Q6_K.gguf` and `mmproj-BF16.gguf` from before the 2026-10-06 switch or the other choices' files, is unused: listed in
Settings > Assistant until the user deletes it), `LICENSE` (Qwen3.5's Apache 2.0 text), `gemma-4-12B-it-README.md` (Gemma 4's
model card, its licence notice, once Gemma is installed), `server.json` `{pid, port, started}` of the running server
(a stale one is killed at the next start when its pid still runs a program of the server's name).

`drafts/<id>.json`: `{ id, title, threadUrl|null, created, updated, pushedAt|null, doc }` — `doc` is TipTap JSON;
whiteboard images are data URLs inside it. Times are ms epoch numbers. `drafts/<id>.history.json`: its undo history (§7e).

File families (`src/file-family.js`, §4): one folder per kind of record, one `<id>.json` per record (`id` a uuid, checked against
`/^[a-f0-9-]{36}$/` before any path is built), `created` / `updated` stamped by main on save, deletes moved into `<folder>/.trash/`
(never hard-deleted):
- `drafts/` (above): the trash also takes the history file.
- `plans/<id>.json`: one plan per thread (docs/plans/gantt-kanban.md §3.2); main checks only the envelope (`threadUrl` a forum topic
  URL, at most 8 MB of JSON); the renderer owns the rest.
- `flowcharts/<id>.json`: the flowchart library (docs/plans/flowchart.md §3.8): `{version, id, threadUrl|null, title, rev, board,
  source, created, updated}`; main checks the envelope (`title` a string ≤ 120 chars, `threadUrl` null or a forum topic URL, `board`
  an object, `rev` an integer ≥ 1, at most 32 MB of JSON: a board may hold images).
- `prefabs/<id>.json`: the user's prefabs (§6g; docs/plans/flowchart.md §3.10), no thread: `{version, id, name, keywords, w, h, items,
  thumb, created, updated}`; main checks the envelope (`name` a string ≤ 80 chars, `items` an array, `w` / `h` numbers, at most 32 MB
  of JSON: a prefab may hold images).
- `plans/`, `flowcharts/` and `prefabs/` keep the replaced version of a record as `<id>.json.bak` (moved to the trash with it), and a file that
  no longer parses is renamed `<id>.json.corrupt-<ms>` when listed (so the next save cannot copy it over the good `.bak`). An
  unreadable draft stays as it is (omitted from the list).

---------------------------------------------------------------------------------------------------
## 4. Main process (main.js, preload.js, src/file-family.js, src/forum-inject.js)

`window.api` (all return Promises; preload uses `ipcRenderer.invoke` with channels named exactly as below):
- `api.settings.get()` → settings merged over defaults (deep default for missing keys; presets default only if key missing)
- `api.settings.set(partial)` → merged settings (persisted)
- `api.drafts.list()` → `[{id,title,threadUrl,updated,pushedAt}]` sorted by `updated` desc
- `api.drafts.load(id)` → draft or null
- `api.drafts.save(draft)` → `{id, updated}`; creates id (`crypto.randomUUID()`) + `created` if absent; sets `updated = Date.now()`.
  Atomic write: write `<file>.tmp` then rename. Validate id matches `/^[a-f0-9-]{36}$/` (no path traversal).
- `api.drafts.remove(id)` → true; moves the file and its history file into `drafts/.trash/` (never hard-deletes)
- `api.drafts.loadHistory(id)` → the draft's history file (§7e) or null; `api.drafts.saveHistory(id, data)` writes it (object or
  null), atomic like drafts, same id validation
- `api.plans.list()` → every plan (whole records), `api.plans.load(id)` → plan or null, `api.plans.save(plan)` →
  `{id, created, updated}`, `api.plans.remove(id)` → true (§3 `plans/`). Channels `plans.list|load|save|remove`.
- `api.flows.list()` → `[{id, threadUrl, title, created, updated, rev, items}]` (`items` = the board's item count),
  `api.flows.load(id)` → record or null, `api.flows.save(record)` → `{id, created, updated, rev}`, `api.flows.remove(id)` → true
  (§3 `flowcharts/`). Channels `flows.list|load|save|remove`. A refused envelope rejects with its message.
- `api.prefabs.list()` → `[{id, name, keywords, w, h, items, thumb, created, updated}]` (`items` = the item count: thumbnails, no
  items), `api.prefabs.load(id)` → record or null, `api.prefabs.save(record)` → `{id, created, updated}`, `api.prefabs.remove(id)` →
  true (§3 `prefabs/`). Channels `prefabs.list|load|save|remove`. A refused envelope rejects with its message.
- `api.forum.status()` → `{loggedIn, memberId, name, profileUrl}`
- `api.forum.login()` → opens the forum window at `https://daf.staffs.ac.uk/login/`; polls status every 2 s in that window
  (executeJavaScript of STATUS_SCRIPT after each `did-finish-load`/`did-navigate`) and resolves the status once logged in
  (then navigates the window to the forum home, leaves it open) or when the window is closed.
- `api.forum.discover()` → `{threads:[…]}`; rejects with Error('not-logged-in') when not logged in.
- `api.forum.describe(urls)` → `{threads:[{url, title, subject, year, forum}]}` for up to 50 topic URLs (each checked against the topic
  URL pattern), read from each topic page's JSON-LD breadcrumbs by the same code as discover (`describeThreadsScript`, forum-inject.js);
  a page that cannot be read or has no breadcrumbs past Home is left out (discover skips it too).
- `api.forum.push({threadUrl, html, images:[{name, base64, width, height}]})` → `{ok:true, attachments}` or `{ok:false, error}`.
  Validates `threadUrl` matches `^https://daf\.staffs\.ac\.uk/topic/\d+[^\s]*$`. Shows/reuses the forum window, loads threadUrl,
  waits for `did-finish-load`, runs `buildPushScript(payload)` via `executeJavaScript(src, true)`, focuses the window.
  The user reviews and clicks Submit themselves. NEVER auto-submit.
- `api.forum.open(url)` → loads a daf.staffs.ac.uk URL in the forum window.
- `api.window.zoom(dir)` → main window zoom level: dir 1 = +0.5, -1 = -0.5 (range -3…5), 0 = reset to 0; the window controls'
  height follows (33 px × zoom factor, so they keep the title strip's height).
- `api.window.titleBar({color, symbolColor})` (`#rrggbb` each, else rejects) → the window controls' background and symbol colours
  (`setTitleBarOverlay`); the title strip (§7) sends its own computed colours at start and on every theme change.
- `api.dictation.*` (§7h, `src/dictation-main.js`): `status(over?)` → `{ready, url, missing:[{label, bytes}], models:[{id, label, note, bytes, downloaded}]}` for settings.dictation with `over` laid on it, `install(model)` → true, `cancel()`, `warm()`, `transcribe(wavBytes)` → text, `listModels()` → `[{id, label, file, bytes}]`, `deleteModel(id)` → true, `onProgress(fn)` → unsubscribe (event `dictation.progress`). Channels `dictation.status|install|cancel|warm|transcribe|listModels|deleteModel`.
- `api.assistant.*` (§7i, `src/assistant-main.js`, pure helpers `src/assistant/runtime.js`, Node-tested in
  `test/assistant-runtime.test.mjs` against the stub `test/fixtures/llama-stub.js`): `status(over?)` → `{ready, url, missing:[{label,
  bytes}], backend, server:{state: 'stopped'|'starting'|'ready'|'error', error?, sleeping?}, model:{label: 'Qwen3.5-9B Q4_K_M', bytes},
  licence: 'Apache-2.0', leftovers:[{file, bytes}]}` (`leftovers`: the `userData/assistant/models/*.gguf` that are neither the pinned files nor used by the settings) for settings.assistant with `over` laid on it (`url` is `serverUrl` only: the renderer never sees the
  local port or key; `sleeping` from `GET /props` while the local server is up, and at `serverUrl`), `install()` → true, `cancel()`,
  `warm()` → true once the server answers (starts it, or wakes a sleeping one with `POST /tokenize`), `stop()` → true, `delete()` →
  true (stops the server, removes `userData/assistant/`; refused while an install runs), `deleteLeftover(file)` → true (deletes
  `userData/assistant/models/<file>` when `file` is one of `leftovers` by name, else refuses; stops a server still running on it), `chat({rid, messages, tools?, think,
  used?, response_format?})` → true at once, then the stream as events, `cancelChat(rid)` (aborts the request; no more events for `rid`),
  `onEvent(fn)` → unsubscribe. Channels `assistant.status|install|cancel|warm|stop|delete|deleteLeftover|chat|cancelChat`; events on
  `assistant.event`: `{type: 'progress', step, steps, label, received, total}` | `{type: 'status', server}` | `{rid, type: 'delta',
  text}` | `{rid, type: 'reasoning', text}` | `{rid, type: 'tool_call', id, name, arguments}` (arguments = the JSON string, one event
  per call, sent at the finish) | `{rid, type: 'done', finish_reason}` | `{rid, type: 'error', message}` | `{rid, type:
  'novision'}` (the server has no image projector: the request went without its image parts, §7i Vision). `messages` are OpenAI chat
  messages (with `{role: 'assistant', tool_calls}` and `{role: 'tool', tool_call_id, content}`; a user message's content may be
  content parts with `image_url`), `tools` OpenAI function tools.
- `api.computer.*` (§7i Computer use, `src/computer-main.js`): `act({action, target, x?, y?, button?, path?, text?, keys?, dx?, dy?,
  ms?})`, `open({draftId, title})` and `close()` → a screenshot `{target, url, width, height, draftId?, title?}` (close: `{closed}`), or
  `{error, code}` (never a rejection); `pane(on)` (the pane's frames on or off), `onEvent(fn)` → unsubscribe. Channels
  `computer.act|open|close|pane`; events on `computer.event`: `{type: 'worker', draftId, title}` (the background window took a
  draft; `draftId` null: it closed) | `{type: 'saved', entry}` (it saved its draft; `entry` the sidebar entry) | `{type: 'frame', url}`
  (a JPEG data URL, at most 960 px wide, only while the pane shows).

Sessions/windows:
- Forum session: `session.fromPartition('persist:daf')`. Set `app.userAgentFallback` to the default UA with ` Electron/x.y.z`
  and ` daf-writer/x.y.z` tokens removed (SSO providers block embedded UAs).
- Forum window: single BrowserWindow (1500×1000, partition persist:daf, contextIsolation true, nodeIntegration false,
  sandbox true, no preload). Reuse if open. Popups (SSO) allowed to open as child windows in same partition.
- Worker window (status/discover): hidden BrowserWindow, same partition, load `https://daf.staffs.ac.uk/`, executeJavaScript; destroy after.
  Timeout 45 s for discover.
- Background window (§7i Computer use): created on demand by `computer.open`, 1440 × 900 content, never shown,
  `webPreferences.offscreen` (it paints and captures while hidden), `backgroundThrottling: false`, the main window's preload and
  sandbox, index.html with `?worker=1&draft=<id>`; links and navigation denied, file pickers intercepted (CDP
  `Page.setInterceptFileChooserDialog`, so no native dialog shows). Destroyed by `computer.close`, 5 minutes after its last action
  and when the main window closes (main waits for its last save before `app.quit()`).
- Main window: 1600×1000, preload, contextIsolation true, sandbox true, nodeIntegration false, spellcheck true, loads index.html.
  `setWindowOpenHandler` → deny; http(s) URLs go to `shell.openExternal`. Block `will-navigate` away from the app file.
- Context menu on main window: spelling suggestions (`replaceMisspelling`), "Add to dictionary", separator, Cut/Copy/Paste/Select All.
  Boards show their own menu instead (§6c Board menu), except over the text being edited.
- Main window frame: custom. `titleBarStyle: 'hidden'` with `titleBarOverlay` (`TITLE_BAR` = color `#0a0a0a`, symbolColor
  `#f5f5f5`: the always-dark chrome's --background / --foreground, height 33): no native title bar; the Window Controls Overlay draws
  the minimize / maximize / close buttons over the right end of the renderer's title strip (§7), which is the drag region
  (double-click maximizes, right-click shows the system menu). `win.removeMenu()`: the main window has no menu, so Alt, Alt+key
  and F10 open or focus nothing. Of the old default menu's accelerators: Blink handles the Edit keys (Ctrl+Z / Y / X / C / V / A)
  in inputs and the editor itself, the renderer the window zoom (§7), DevTools keeps Ctrl+Shift+I (`before-input-event`), and
  Reload, F11 full screen, Ctrl+M minimize and Ctrl+W close have no key any more (reload would close the window). The forum
  window and the worker window keep the native frame (the forum window its menu bar).

Every channel is registered through `handle()`, which refuses any sender but the main window and the background window. The
background window may call only `settings.get`, `drafts.list|load|loadHistory`, `drafts.save|saveHistory` for its own draft,
`plans|flows|prefabs.list|load`, `assistant.status` and `dictation.status|listModels`; any other call rejects ("<channel> is not
available in the background window"), so it never writes settings.json, plans, flowcharts or another draft, and never reaches the
forum.

`src/file-family.js` (CommonJS): the storage helpers (`serialized` write queue, `readJson`, `writeJsonAtomic`: `<file>.tmp` then
rename, `setAside` for a corrupt file) and `fileFamily(dir, {summary?, keepPrevious?, maxBytes?, validate?, siblings?})` →
`{file, list, load, save, remove}` over the folder `dir()`: `list()` = every readable `<uuid>.json` (or `summary(record)`) by
`updated` desc; `save(record)` checks it is an object, runs `validate` (throws the refusal), gives a new record an id and `created`,
sets `updated`, checks `maxBytes`, then (in the write queue) copies the old file to `.bak` when `keepPrevious` and writes atomically;
`remove(id)` moves the file, its `.bak` and `siblings(id)` into `.trash/`. main.js builds `drafts` (summary = the list entry,
siblings = the history file; `drafts.save` keeps its `{threadUrl: null, pushedAt: null, …draft}` defaults and returns
`{id, updated}`), `plans` (`keepPrevious`, 8 MB, envelope), `flows` (`flowcharts/`, summary, `keepPrevious`, 32 MB, envelope) and
`prefabs` (summary with the thumbnail, `keepPrevious`, 32 MB, envelope) on it. Settings stay one file (`settings.json`) with the same helpers.

`src/forum-inject.js` (CommonJS, `module.exports = { buildPushScript, STATUS_SCRIPT, DISCOVER_SCRIPT }`):
- `STATUS_SCRIPT`: expression string → `{loggedIn, memberId, name, profileUrl}` (works when `ips` missing → loggedIn false).
- `DISCOVER_SCRIPT`: async IIFE string doing §1 discovery in-page → `{threads:[{url,title,subject,year,forum}]}` or `{error}`.
- `buildPushScript(payload)`: returns an async IIFE string (payload embedded with JSON.stringify) that:
  1. polls ≤15 s for `textarea[data-role="contentEditor"]`; `form = ta.form`.
  2. if no `form.querySelector('.ProseMirror')?.editor`: click `form.querySelector('.ipsComposeArea_dummy')`, poll ≤15 s.
  3. poll ≤20 s for the uploader (`[data-ipsuploader]`, else error "forum uploader unavailable"); upload images one by one
     via `injectFile` (File from base64, `type` field), waiting ≤180 s for `ready` per image (error/timeout → error
     `upload failed for image i+1`, post untouched).
  4. `ed.commands.setContent(payload.html)`; for each i find `[[IMG:i]]` (text scan); if it is its paragraph's only text,
     widen the range to the whole paragraph; `ed.chain().insertContentAt(range, content_i).run()`.
  5. one transaction: every `ipsAttachment` whose fileId is one of ours → `setNodeMarkup(pos, null, {...attrs, attachmentWidth: width, alignStyle: 'block'})`.
  6. `form.scrollIntoView({block:'center'})`, `ed.commands.focus('end')`, return `{ok:true, attachments: n}`. Catch → `{ok:false, error: String(e.message||e)}`.

Smoke mode (`electron . --smoke`): main window shown inactive; after `did-finish-load` run
`executeJavaScript('window.__smoke()', true)` → `{html, images:[{name,width,height,base64}], text}`; write
`smoke-output.json` (base64 replaced by byte length) and every image as `smoke-wb-<i>.png` (document order) into `process.cwd()`;
`capturePage()` of main window → `smoke-ui.png`; then `app.exit(0)`. Any error → write `smoke-error.txt`, `app.exit(1)`.
Overall timeout 60 s → exit 2.

`--data-dir=<path>` (any run): main creates the folder and calls `app.setPath('userData', <path>)` at load, before ready, so
settings, drafts and every file family live there (the single-instance lock follows userData). `--script=<file>` in smoke mode
(`electron . --smoke --data-dir=<dir> --script=<file>`): after `did-finish-load`, main waits for `window.__agent`, runs
`window.__agent.script(JSON.parse(<file>))` (§8 Smoke script) instead of `window.__smoke()`, writes the per-step
`[{req, res, pass}]` as `smoke-agent.json` into `process.cwd()` and exits 0, or 1 when a step failed its `expect` (an error:
`smoke-error.txt`, exit 1; the 60 s smoke timeout applies). The drafts it creates persist in the data dir (only `__smoke()` sets
`state.smoke`); without `--data-dir` main refuses `--script` (stderr line, exit 1), so a script never writes the real profile.
`npm run smoke:agent` = `npm run build && electron . --smoke --data-dir=.smoke-data --script=test/smoke/agent-basic.json`.

---------------------------------------------------------------------------------------------------
## 4b. GitHub backup (src/github-sync.js)

Backs up to one private GitHub repository of the user's through the REST API only (no git CLI). Synced files, at the same paths
in the repository: `drafts/<id>.json` and `drafts/<id>.history.json` (the undo history, §7e), `plans/`, `flowcharts/`, `prefabs/`
(`<id>.json` only: no `.bak`, `.trash/` or corrupt files), `settings.json` (only `threads`, `folders`, `draftFolders`,
`draftOrder`, `draftTags`, `tags`) and the marker `.easywriter`.

- Login: GitHub's device flow for the OAuth app `CLIENT_ID` (env `EASYWRITER_GITHUB_CLIENT_ID`; Device Flow enabled; scope
  `repo`). Main opens GitHub's page, Settings shows the code. The token is encrypted with `safeStorage` in
  `github-token.json` in userData and never reaches the renderer. A 401 logs out.
- Settings: `github: {enabled, repo: 'owner/name', intervalSec: 300, onClose: 'ask' | 'push' | 'skip'}`. Settings > GitHub
  backup lists the user's private repositories they can push to. A repository must be private and either empty or hold
  `.easywriter` (an EasyWriter backup); any other is refused, in Settings as it is picked and again by every sync.
- Sync (one at a time): reads the default branch head. When it is not the commit in `github-sync.json` (`{repo, head, files:
  {path: blob sha}}`, the last sync), main covers the window ("Syncing with GitHub..."), the renderer saves everything
  (`window.__sync.flush()`, after the background window closes) and each file is merged three ways against `files`: changed
  only there is copied here, changed only here stays, changed on both sides asks once (Use the GitHub version | Keep this
  computer's version | Not now, each line naming which side saved last). Files replaced or deleted here are first copied or
  moved to `github-backups/<time>/` in userData. After copying, the renderer reloads (`window.__sync.reload()`). Then the
  local files are committed on top of the head unless the tree already matches: one tree request lists every file (unchanged
  ones by sha, the rest inline up to 8 MB per request, then more requests on that tree; a file over 8 MB as its own blob), a
  commit "Backup from <hostname>", the branch moved without force (a moved branch syncs again once). An empty repository
  first gets `.easywriter` through the contents API (the git database API refuses empty repositories).
- When: the renderer's start (`github.start`), login with the backup on, turning it on or picking another repository, Push now,
  and every `intervalSec` (at least 30) when a synced file was written since the last sync (`drafts|plans|flows|prefabs`
  `.save|saveHistory|remove`, or a synced settings key). A failed sync is a toast and tries again on the next tick.
- Close: logged in with the backup on and `onClose` not `skip`, closing the window first saves, then with unpushed changes
  asks "Push your changes to GitHub before closing?" (Push | Don't push | Cancel, "Don't ask again" stores the choice in
  `onClose`), or pushes at once for `push`. A failed push asks Close anyway | Stay. Restart for an update skips it.

---------------------------------------------------------------------------------------------------
## 5. Editor (src/extensions.js, src/doc-utils.mjs, src/export.js)

`src/extensions.js` exports:
```js
export const FONT_SIZES = [80, 90, 100, 125, 150, 175, 200];
export const TEXT_COLORS = { root:'Default', soft:'Faint', hard:'Prominent', red:'Red', orange:'Orange', yellow:'Yellow', green:'Green', blue:'Blue', indigo:'Indigo', violet:'Violet' };
export const HIGHLIGHTS = ['red','orange','yellow','green','blue','indigo','violet'];
export const FONTS = [ {label:'Helvetica', css:'Helvetica'}, …, {label:'Andalé Mono', css:'Andale Mono'}, … ]; // §1 order
export const FontSize;   // Mark 'fontSize', attr size (string '80'…'200'); parse span[data-ips-font-size] (allowed values only);
                         // render ['span', {'data-ips-font-size': size}, 0]; commands setFontSize(size) (100/null ⇒ unset), unsetFontSize()
export const TextColor;  // Mark 'textColor', attr color; parse span[data-i-color] (keys except 'root'); render data-i-color;
                         // commands setTextColor(key) ('root'/null ⇒ unset), unsetTextColor()
export const Highlight;  // Mark 'highlight', attr color (default 'yellow'); parse mark[data-i-background-color] (allowed) and plain <mark> (yellow);
                         // render ['mark', {'data-i-background-color': color}, 0]; commands setHighlight(key), unsetHighlight()
export const FontFamily; // Mark 'fontFamily', attr font (css name); parse span[style*=font-family] whose first family (quotes stripped,
                         // case-insensitive) is in FONTS; render span style `font-family: <quoted-if-space>`; commands setFontFamily(css) ('' ⇒ unset), unsetFontFamily()
export const Box;        // Node 'box' (group block, content 'boxTitle boxContent', defining) + 'boxTitle' (content 'inline*') + 'boxContent' (content 'block+')
                         // parse/render exactly the forum Box HTML in §1 (title parse: div.ipsRichTextBox__title, contentElement the inner p if present).
                         // Export Box as an array or object your buildExtensions includes (BoxTitle, BoxContent too). command insertBox()
export function buildExtensions(historyDepth); // [StarterKit.configure({heading:{levels:[1,2,3,4,5,6]}, link:{openOnClick:false, autolink:true, defaultProtocol:'https'}, undoRedo:{depth: historyDepth}}),
                                     //  TextAlign.configure({types:['heading','paragraph']}), Subscript, Superscript, Table.configure({resizable:false}),
                                     //  TableRow, TableHeader, TableCell, FontSize, TextColor, Highlight, FontFamily, Box(+parts), Whiteboard, WhiteboardPaste,
                                     //  Canvas (§6b), PlanChart (§6e)]
export function applyPreset(editor, preset); // one chain: unset fontFamily/fontSize/textColor/highlight/bold/italic/underline on selection, then set preset values
```
Markdown-style input rules come from StarterKit (`# `…`###### ` headings on space, `- ` / `* ` bullets, `1. ` ordered, `> ` quote,
```` ``` ```` code block, `---` hr, `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``). Keep them enabled.

`src/doc-utils.mjs` (NO imports; pure functions on TipTap JSON; never mutate input):
- `applyBaseStyles(doc, {baseFont, baseSize})`: if `baseFont` truthy, every text node without a `fontFamily` mark gets
  `{type:'fontFamily', attrs:{font: baseFont}}` — except inside `codeBlock` or text with a `code` mark. If `baseSize` !== 100,
  every text node without a `fontSize` mark gets `{type:'fontSize', attrs:{size: String(baseSize)}}` — except inside headings,
  `codeBlock`, or with a `code` mark.
- `replaceWhiteboards(doc)` → `{doc, boards}`: each `whiteboard`, `canvas` or `planChart` node (any depth, document order) is replaced by
  `{type:'paragraph', content:[{type:'text', text:'[[IMG:i]]'}]}`; `boards[i]` = that node's attrs plus `kind: 'whiteboard' | 'canvas' |
  'planChart'`.
- `chartRefs(doc)` → `[{id, planId}]`: the plan charts (§6e) in document order (Delete plan counts the drafts that chart it).
- `draftTitle(doc)` → first non-empty block's plain text, trimmed, max 60 chars (append '…' if cut), else 'Untitled draft'.
- `wordCount(doc)` → number of whitespace-separated words across text nodes.

`src/export.js`:
- `export async function buildPayload(editor, settings)` → `{html, images:[{name:'whiteboard-<n>.png', base64, width, height}]}`.
  `json = editor.getJSON()`; `{doc, boards} = replaceWhiteboards(applyBaseStyles(json, settings))`;
  `html = generateHTML(doc, editor.extensionManager.extensions)` (`@tiptap/core`); each board →
  `rasterizeWhiteboard(board, {width: <board's drawn .wb offsetWidth, fallback settings.forumWidth>, theme: settings.theme, scale: 2})` → base64 without `data:` prefix.
  `width` = that same board width (display width in CSS px), `height` = board.height. If a PNG exceeds 19 MB, re-encode as JPEG 0.9
  (keep the `.png` → `.jpg` name and pass type accordingly — add `type` field 'image/png'|'image/jpeg' to each image; push script uses it).
  Canvas boards (§6b): `drawn` = the node's drawn `.sc` offsetWidth (fallback `min(dw, forumWidth)`); rasterize
  `{height: h, bg, items}` at `width: w` with `scale = clamp(2 * drawn / w, 0.25, 4)`; image name `canvas-<n>.png`, `width: drawn`,
  `height: round(drawn * h / w)`. A synced canvas (§6f) first takes its library record's live `w h frame bg items` (all synced
  records loaded in parallel through `flowSource.load`); a missing record leaves the node's own attrs (its cache). Plan charts
  (§6e): `drawn` = the `.pc` offsetWidth (fallback `min(dw ?? forumWidth, forumWidth)`);
  `rasterizePlanChart(attrs, {width: drawn, theme, n})` (src/plan-chart.js) → the PNG at the chart's layout width × 2, named
  `plan-<n>.png` (n = the image number), `width: drawn`, `height` = the rendered height at the drawn width; a refused chart fails
  the push with its message. Drawn widths are read in document order from `editor.view.dom.querySelectorAll('.wb, .sc, .pc')`.
- Re-export `applyBaseStyles, replaceWhiteboards, draftTitle, wordCount` from doc-utils.

---------------------------------------------------------------------------------------------------
## 6. Whiteboard (src/whiteboard.js)

Node `whiteboard`: group block, atom, selectable, draggable false.
Attrs: `height` (number, default 400), `base` (number | null, default null; §6c smart height), `bg` ('post'|'transparent'|'white'|'black', default 'post'), `items` (array, default []).
`parseHTML: div[data-whiteboard]` reading JSON from `data-json`; `renderHTML: ['div', {'data-whiteboard':'', 'data-json': JSON.stringify(attrs)}]`.
Commands: `insertWhiteboard(attrs?)`.

Item shapes (coordinates in CSS px relative to board top-left at 100 % zoom; board width = forumWidth = 100 % of page content; new boards are always inserted at the top level):
- image: `{id, type:'image', src, x, y, w, h, crop?}` (crop: §6c)
- text: `{id, type:'text', html, x, y, w, size:20, color:'#ffffff', bold:false, align:'left', bg:null, h?}` (bg null | '#rrggbb' sticky note; a new one: w 200 × the board's unit, size, colour, bold and bg from the text defaults, §6c Tool settings and Units).
  `h`: the rendered height in board px, written for every text item by each Board commit, a cache for pure code (§6d routing);
  rendering and the Board ignore it and measure the element (text still auto-grows). parseHTML drops a non-finite `h`.
- stroke: `{id, type:'stroke', x, y, w, h, vw, vh, d, color, width, opacity}` — freehand pen line. x/y/w/h = point bbox padded by width/2 + 1;
  vw/vh = w/h at creation (the SVG viewBox); `d` = SVG path in bbox-local coords (quadratic curves through point midpoints; a click = `M x y l0 0` dot);
  width in board px (picked in post px: 1,2,3,4,6,8,12,16,24, §6c Units); opacity 1 (Pen) | 0.7 (Marker) | 0.35 (Highlighter). parseHTML drops strokes with a non-string `d`/`color`,
  a non-finite numeric field, or vw/vh ≤ 0.
- shape: `{id, type:'shape', shape, x, y, w, h, color, width, opacity, fill, fillColor, flipX, flipY, rot?, html?, size?, textColor?,
  bold?, align?, valign?}` (Shape tool below; `shape` any kind of the registry, §6d; `rot`, the label `html` and its style: §6d).
- connector: `{id, type:'connector', from, to, route, corner, points, heads, color, width, opacity, dash, jump, labels}` plus the
  derived `x, y, w, h, d, tips, lps` — an arrow whose ends stick to items (§6d).
Array order = z-order (last on top). ids: short random strings.

Exports:
```js
export const Whiteboard;        // Node
export const WhiteboardPaste;   // Extension: ProseMirror plugin handlePaste/handleDrop for image FILES.
                                // NodeSelection on a whiteboard (paste) or drop target inside a whiteboard DOM → add image(s) to that board
                                // (drop: at drop point; paste: centred), scaled to ≤ 60 % board width.
                                // Otherwise insert one NEW smart canvas (§6b) per image at the selection/drop pos (after a
                                // node-selected canvas), in order: artboard = the image's natural size (at most 8000 px per
                                // side), the image at 0,0, `dw = min(w, content width)`. Return true.
                                // (A canvas being edited handles its own paste/drop, §6b.)
                                // Non-image pastes fall through (return false).
export function addImageFilesToEditor(editor, files);   // used by the toolbar "Image" button: same logic as paste
export const WB_BG = { post:{dark:'#303039', light:'#ffffff'}, transparent:null, white:'#ffffff', black:'#000000' };
export async function rasterizeWhiteboard(attrs, {width, theme, scale = 2}); // → {blob, width, height}
       // Offscreen replica (no handles/toolbars) appended to document.body at left:-100000px, same item CSS as the NodeView,
       // html-to-image `toBlob(node, {pixelRatio: scale, width, height: attrs.height, backgroundColor: resolved bg or undefined})`, then remove.
       // Must wait for all <img> in the replica to decode before capture.
```
NodeView (class or function, created in `addNodeView`):
- Container `.wb` position:relative, width 100 %, height = attrs.height, background from WB_BG and current theme
  (theme read from `document.documentElement.dataset.theme`), dashed outline on hover/selected, `user-select:none`. While it is
  not in use (not focused, node-selected or in a tool mode) its empty area shows the pointer (hand) cursor (items keep their move
  cursor) and the §6b hover hint: empty area "Click to select.", an image item "Click to select. Double-click to edit the
  image.", a canvas item "Click to select. Double-click to edit.".
- Tools, board actions and item properties live in the §6c chrome (tool rail, options flyouts, item ribbon), outside the board's
  DOM. Image (I) opens a file picker (`<input type=file accept=image/* multiple>`); a click places the picked images (§6c
  Placement tools).
- Pen / Eraser (per board view, mutually exclusive; Escape or clicking the active toggle exits; entering deselects items and ends editing):
  pen settings live in one module-level object shared by all boards and kept across sessions (§6c Tool settings; default #e05252, 4 px, Pen).
  Pen: crosshair cursor; pointerdown anywhere except the height bar draws (never selects/moves). Points in board coords (zoom-aware,
  coalesced pointer events included), points < 1.5 px apart dropped, live SVG preview; pointerup adds one stroke item (one commit = one undo step; the history group is closed so quick strokes never merge).
  Eraser: dragging deletes every stroke whose hit path the pointer crosses (`document.elementFromPoint`, interpolated every 4 px; images/text
  are never erased); one commit (own undo step) per gesture. Any other tool (Text, Shape, …) turns pen/eraser off.
- Stroke rendering (itemElement, shared with the rasterizer): `div.wb-item.wb-stroke` (CSS pointer-events:none, `auto` while selected so the
  handle works; height = h) holding `<svg width/height 100% viewBox="0 0 vw vh" preserveAspectRatio=none overflow=visible>` with the visible
  path (fill none, round caps/joins, opacity, `vector-effect: non-scaling-stroke`) and a transparent hit path (stroke-width max(width, 14 post px),
  `pointer-events: stroke`) — the line is clickable, its bbox is not. The transparent hit path paints nothing in exports.
- Items absolutely positioned. pointerdown selects (Shift adds; several items: §6c Multi-selection; the selection is kept across re-renders) and starts drag with pointer capture.
  Zoom-aware: pointer positions are converted to board px with `scale = container.getBoundingClientRect().width / container.offsetWidth`
  and gestures work in board coordinates (§6c auto-scroll). Snapping, Shift axis lock and Alt + drag copy: §6c.
- A single selected item shows four corner resize handles (nw, ne, sw, se; nwse/nesw cursors). Dragging a corner resizes with the opposite
  corner fixed. Images and strokes keep aspect ratio unless Shift; shapes resize freely unless Shift; text resizes width only (west
  handles move its left edge). Min 20 px per side, or the side's start size if already smaller (aspect-locked: one scale for both
  axes, the larger side ≥ 20 px or its start size if smaller); dragging past the opposite corner stops at the minimum (no flip). Handles and the selection outline keep a constant
  on-screen size at any zoom (CSS var `--wb-inv` = 1 / scale on the board). A shape also has four edge handles (n, e, s, w; one side
  only, no aspect rule) and a rotate handle; a turned shape resizes in its own frame (§6d Arrangement and rotation).
- Bounds (whiteboard; a canvas has none, its artboard follows the content: §6b smart artboard): every item stays inside the
  board: `0 ≤ x`, `x + w ≤ board width`, `0 ≤ y` (the bottom is not a bound: a whiteboard grows instead, §6c). Enforced on move,
  nudge, resize (the drag stops at the board edge; aspect-locked resizes cap the scale), paste /
  duplicate, Reset size, add text, add image and while drawing (pen and shape points are clamped to the board). An added image is
  scaled to ≤ 60 % of the board width; the board grows to hold it. Legacy items stored outside the bounds render as stored and are
  clamped the next time they move; an item wider than the board is pinned to x = 0.
- Text item: double-click → contenteditable editing; Ctrl+B/I work natively. Editing ends (commit innerHTML) on pointerdown elsewhere on the
  board, Escape, adding an item, or focusout whose relatedTarget is outside the board (element.blur() and window deactivation included;
  focus moving into board chrome (rail, flyouts, ribbon and their popups, all marked `data-board-chrome`) keeps editing; focus then
  moving from that chrome to anywhere else ends it). The ribbon stays visible while editing and follows the text as it grows; a
  ribbon change mid-edit keeps the typed text, restyles the live element, commits, then refocuses the text and restores the
  caret/selection saved on pointerdown/focusin in the chrome (chrome backgrounds and buttons never take focus).
  Text item ribbon: colour, size select in post px (12,14,16,18,20,24,28,32,40,48,64,72; §6c Units), Bold toggle, align (L/C/R),
  note colour (none / #fff59d / #c8e6c9 / #bbdefb / #f8bbd0).
- Image ribbon: Reset size (natural size of the visible region, capped to the board width; the board grows to hold it),
  Reset crop (§6c). Front, Back, Duplicate and Delete are rail buttons for every item type; they act on the whole selection (§6c).
- Stroke ribbon: colour, width, style (edit that stroke).
- Keyboard: the §6c set (Ctrl+J or the rail's Duplicate duplicates the selected items +20 px; Ctrl+D deselects).
- Shape tool (Shape mode, like Pen): drag draws `{type:'shape', shape, x, y, w, h, color, width, opacity, fill, fillColor, flipX, flipY}`;
  shape: any kind of the registry, picked in the shape list (§6d); fill ∈ none, solid, hatch. Geometry is computed in
  item pixels (viewBox 0 0 w h) so heads/bumps never distort; line/arrow boxes are padded and their endpoints are opposite corners
  chosen by flipX/flipY. Shift = square / 45° steps. A click without drag drops a default 160 × 110 post px shape, or its kind's own
  size (§6d; §6c Units). Shapes resize freely
  (Shift keeps aspect). Tool settings (shared across boards, kept across sessions: §6c Tool settings) apply live while a colour picker is open; item colours commit on close.
- Ctrl+A while editing a text item selects only that item's text.
  Copy stores the selected items in a module-level clipboard and writes a one-off token to the system clipboard; Ctrl+V pastes the
  items (+20 px, cascading, relative positions kept) into the focused or node-selected board only while the system clipboard still holds that token
  (a board of another unit converts them, §6c Units).
- Bottom edge bar (8 px tall, row-resize cursor) drag → `base` (§6c).
- The interactive surface is the exported class `Board` (items, selection, tools, gestures, adding image files), which knows
  nothing about ProseMirror or React: it talks to a small host object (commit attrs, undo/redo, empty-area click, delete board;
  a canvas also tells it when its items shift, so it can keep them in place on screen, and gets back what it could not keep, §6b)
  and supports a fluid width (whiteboard: width 100 %, variable height) or
  an artboard (canvas: w × h following its content, §6b smart artboard; no height bar, `Fit height` or `Delete board`). Auto-scroll
  scrolls, and the ribbon stays inside, the board's nearest scrolling ancestor (the editor area).
  Chrome observes a board through `subscribe(fn)` / `getSnapshot()` (kind, mode, selected item properties, editing, pen and shape
  tool settings, snapping rules, background, undo / redo availability from optional `host.canUndo()` / `host.canRedo()`; the object
  keeps its identity until one of these changes), drives it through one action method per control, hands focus back with `focus()`
  (the caret into the text being edited, else the board), and finds the board it serves in the exported `activeBoard` store
  (`get()`, `subscribe(fn)`). `WhiteboardView` also emits on every editor transaction, so undo / redo availability follows the
  whole document. `WhiteboardView` is a thin NodeView adapter around it; `nodeView.dom.wbView` is the Board (used by the paste plugin).
- Clicking empty board area without a drag → `editor.commands.setNodeSelection(getPos())` and deselect (a drag there draws a
  selection rectangle, §6c).
- Commit every change via `view.dispatch(view.state.tr.setNodeMarkup(getPos(), undefined, newAttrs))`; during a drag/resize
  gesture mutate DOM only and commit once on pointerup (one undo step per gesture).
- `update(node)`: if type differs return false; re-render from attrs unless a gesture/edit is in progress; return true.
- `stopEvent()` → true for events inside the view (so ProseMirror ignores them), `ignoreMutation()` → true,
  `selectNode/deselectNode` toggle a class.
- A new text item takes the text defaults (§6c Tool settings): nothing saved = size 20, colour '#ffffff' when theme dark,
  '#111111' when light, not bold, no note.

---------------------------------------------------------------------------------------------------
## 6c. Board interaction and chrome (every Board: whiteboards and a canvas being edited)

Where this section conflicts with §6 or §6b, this section wins and the conflicting sentences there get rewritten.

Units: every item size the chrome shows or takes (text size, the line width of a stroke / shape, the pen / eraser / shape tool
width in the rail flyout, quick tools and tool search) is in post px (the px of the post at 100 % page zoom). A Board's unit =
board px per post px: 1 on a whiteboard (board px = post px); 1 / k on a canvas being edited (k = its display scale without the
page zoom, fixed for the edit session, §6b). Shown = stored / unit, rounded to a whole px (min 1; a value missing from a select's
list is added to it, sorted); picking v stores v × unit (rounded to 0.01). New items store the shared tool settings (post px) ×
unit: text size × unit and its 200 px box width × unit, stroke / shape width × unit, the click-placed 160 × 110 shape box (or its
kind's own, §6d) × unit; stroke / shape hit paths are at least 14 post px (CSS var `--wb-unit`). Items pasted on a board of another unit (copied in
a canvas being edited, pasted on a whiteboard, …) keep their look in post px: x, y, w, h (whole px), text size and line width ×
target unit / source unit. Otherwise positions, boxes, snapping, the grid and the canvas W / H (artboard px) are not converted;
saved data, rendering and export are unchanged.

Tool settings: the pen (colour, width, style; the eraser has no settings and no options flyout), the shape tool
(shape, line colour, width, style, fill, fill colour; label size and colour once the flowchart preset set them, §6d), the text
defaults (size, colour, bold, note: the last ones set on a text item, from the ribbon, quick tools or tool search) and the connector
tool (route, heads, line colour, width, style, dash, line jumps; §6d) are shared by every board and kept across sessions in localStorage
(`daf-writer.tools`, sizes in post px; a saved value parseBoard would reject is ignored). Nothing saved: pen and shape #e05252,
4 px, Pen, Box, no fill; text 20 px, colour by theme, not bold, no note; connector Elbow, no start head, arrow end head, 2 px, Pen,
solid, no line jumps, colour by theme. A new text item takes the text defaults.

Smart height (whiteboard only; a canvas artboard follows its content in every direction, §6b smart artboard):
- Attrs gain `base` (number | null; null = same as `height`, which is what old drafts have): the height the user chose (new board
  400, height bar, Fit height). `height` stays the drawn and exported height and is always `max(base, lowest item bottom + 20)`
  (applied on every commit; a stored height that breaks the rule, e.g. in an old draft, is drawn as stored until the next change).
- The bottom edge is not a bound on a whiteboard. Moving, nudging, resizing, pasting, drawing or typing an item past the bottom
  grows the board (live during a gesture, committed on pointerup). When that item is removed, moved up or made smaller the board
  shrinks again: never below `base`, never closer than 20 px to the lowest item.
- Height bar drag sets `base` (min 80; the drawn height still never goes below content + 20). Fit height sets
  `base = max(80, lowest item bottom + 20)`. Top, left and right stay hard bounds (§6 Bounds).

Auto-scroll:
- While a gesture is active (move, resize, crop, pen, shape, eraser, height bar, selection rectangle) and the pointer is within 48 px of the top or
  bottom edge of the scrolling editor area, or beyond it, the area scrolls toward that edge every animation frame (faster the
  closer: `ceil((48 - d) / 4)`, max 12 px per frame) and the gesture keeps following the pointer, also while the pointer rests. Gestures therefore work
  in board coordinates, not in client deltas. Same horizontally when the area scrolls horizontally.
- A canvas being edited (§6b) scrolls the editor area the same way, for item gestures and for artboard resizing.

Snapping:
- Rules, each toggleable, shared by all boards, kept in localStorage (`daf-writer.snap`): master on / off (default on);
  `items`: edges and centres of other items (default on); `board`: board edges and centre lines (default on; on a whiteboard,
  whose bottom moves with its content, only the left, right and top edges and the vertical centre line; on a canvas, whose
  artboard edges move with its content, the frame's edges and centre lines, except while the frame is bound to the moved
  item, §6b);
  `grid`: 10 px grid (default off; while on, a dot grid is drawn on the board, never exported).
- Applies while moving (the edges and centre of the item, or of the group box of several, each axis independently), while resizing or cropping (the moving edges; an
  aspect-locked resize snaps on the x axis and derives y) and to shape start / end points. Threshold 6 screen px (zoom-aware).
  Item and board snaps win over grid snaps. Bounds are applied after snapping.
- While an item or board snap holds, a 1 px guide line (`#ff4d9d`) is drawn across the board at the snapped coordinate. Guides are
  editor-only and disappear when the gesture ends.
- Holding Ctrl while moving, resizing or drawing a shape turns snapping off for that moment (not while cropping, where Ctrl is the
  crop key). Holding Shift while moving constrains the move to the horizontal or vertical axis. Alt no longer snaps to the grid.

Crop (image items):
- Image items gain an optional `crop: {x, y, w, h}`: the visible region as fractions (0…1) of the source image; absent = the whole
  image. The item's `w` / `h` are the displayed size of that region. parseHTML drops an invalid crop (non-finite, w or h ≤ 0,
  outside 0…1).
- `itemElement` renders a clipped wrapper with the image scaled to `w / crop.w` × `h / crop.h` and offset by the crop origin
  (shared with the rasterizer and the canvas preview).
- Ctrl + dragging a corner handle of an image crops instead of resizing: the two edges of that corner move; the picture stays
  where it is on the board and keeps its scale. An edge cannot pass the source image's edge (dragging outward un-crops), the board
  bounds, or a 20 px minimum. One undo step per gesture.
- Without Ctrl the handles scale the cropped image (aspect of the visible region). `Reset size` = natural pixel size of the
  visible region, capped to the board width. `Reset crop` (ribbon; disabled when not cropped) restores the whole image at the
  current scale (scaled down only if it would be wider than the board), clamped into the bounds.

Chrome: tool rail, options flyout, item ribbon (these replace the old top-right bar and the old item bar):
- Tool rail: one floating vertical bar of icon buttons (`lucide` icons; every button has a Tooltip with the action and its
  shortcut) at the left edge of the editor area, outside the zoomed page, vertically centred, constant size at any page zoom (the
  area's wider left padding keeps the page and its boards' handles clear of it).
  It is always shown and never pops in or out, also while a canvas is edited (§6b), which it then serves. In the library editor
  (§7g) it sits at the left edge of the board's view (`#flow-area`, right of the shape panel, following its width and collapse)
  and is centred in that view, not in the column.
  Its height fits the current mode's slots (no empty slots) and changes with a quick 150 ms ease-out transition when the mode
  changes. Its top is placed as if the tallest rail seen (remembered in localStorage `daf-writer.railHeight`) were centred, so
  the anchored zone at the top never moves; only the bottom edge does. In a short editor area (1280 × 720) that top moves up, no
  higher than 0.5rem, until the tallest rail ends where its height cap ends (App's cap keeps the dictation and sidebar buttons
  below it clear), so no slot lies under them.
- The rail is an "island" with two zones:
  - Anchored zone (top; the same four slots at the same place in every mode): Undo (Ctrl+Z) · Redo (Ctrl+Y) · Add image ·
    Add canvas. They act on what is active: with a board active, image and canvas go into that board where it is clicked
    (Placement tools below; canvas: whiteboards only, disabled while a canvas is edited, §6b); otherwise into the document at
    the caret (`addImageFilesToEditor`, `insertCanvas`).
    Undo / redo follow the document history.
  - Context zone (under a separator): its slots swap as a whole with the mode and are fixed within a mode.
    Text mode (no board is active): duplicates of toolbar controls, with the toolbar's commands, icons, active states and
    disabled rules (one shared definition, the toolbar keeps all its controls): Bold · Italic · Underline · Strike |
    Text colour · Highlight (flyouts with the swatches) | Align (flyout: left, centre, right, justify) · Bullet list ·
    Ordered list | Link · Clear formatting | Insert whiteboard.
    Board mode (a board is active): Select (V) · Text (T) · Pen (P) · Eraser (E) · Shape (S) · Connector (A) |
    Duplicate (Ctrl+J) · Bring to front (Ctrl+Shift+]) · Send to back (Ctrl+Shift+[) · Arrange (menu: align, distribute, same
    size; enabled from two selected items, gate `board.selectionMany`, §6d) · Delete (Del), enabled only while an
    item is selected, acting on every selected item | Snapping (Ctrl+Shift+;) | Background | Fit height · Delete board (whiteboard only; disabled while a
    canvas is edited).
  - The active board is the board that has focus, is node-selected or is in a tool mode. Hovering a board does not make it
    active: the mode changes only when the user clicks into a board or back into the text, never from mouse movement. While a
    canvas is edited the rail is in board mode for it. Focus moving from a board into its chrome (a colour swatch, the shape
    panel, §6g) keeps that board active: mid-move the focus is on no element, and the chrome under the pointer (the ribbon, the
    flyout, the library editor's rail) must not unmount before the click lands (a native colour picker then never opened).
- Within a mode every button has a fixed slot: nothing moves or reflows. A button that does not apply is disabled (dimmed),
  never removed. The active tool and active formats are highlighted. Buttons never take focus. After a click on the chrome, or
  when a flyout, menu or select closes, focus returns to the board (or the caret to the text item being edited) in board mode
  and the editor keeps its selection in text mode, so typing and the keyboard set below keep working right away.
- Options flyout: opens to the right of the rail, anchored to its button (top-aligned); it never moves a rail button. A tool's
  options are stacked in a narrow column (10rem; selects full width; a colour swatch shares a row with its select) so they cover
  little of the board. Pen: colour + width, style. Eraser: no flyout (it has no settings). Shape: shape (the shape list, §6d), line colour + width, style, fill + fill colour, style presets. Connector: route, start + end head, line colour +
  width, style, dash, line jumps, style presets (§6d).
  Option lists show a small preview before each label (also in the closed select): shapes (in the shape list's tiles and its
  button) drawn with the board's own geometry, widths as lines of that thickness, styles as a stroke at that opacity, fills as a square. The block style list
  shows each heading at a size like its own; the font list shows each font in itself. Snapping: master toggle and one checkbox per rule.
  Background: Post / Transparent / White / Black. A tool's flyout shows while that tool is active (Escape leaves the tool); the
  others open on click and close on outside click or Escape.
- Item ribbon: a small translucent bar (the quick tools' card: 70 % opacity, 2 px blur, §7d) of wrapping rows (at most 24rem
  wide) holding only the selected item's properties, most used first so the main colour is first: text: colour, size, bold,
  align L / C / R, note colour; stroke: colour, width, style; shape: fill colour, line colour, width, style, fill, Label (popover:
  label size, colour, bold, align, vertical align), shape, Style presets (popover), Rotate 90°, Angle; connector: colour, width,
  style, start head, end head, route, dash, line jumps, Labels (popover), Style presets (popover), Reverse, Straighten (§6d);
  image: Reset size, Reset crop; canvas: Edit, Reset size. Also the quick tools' item row and the tool search's item options.
  - Several items selected (2026-10-07, the user: "when i select things i should be able to edit things that are in common";
    whiteboard.js `groupProps`, `setItems`): items of one type (text, shape, connector or stroke) show that type's ribbon; shapes,
    connectors and pen strokes together show line colour, width and style only; any other mix, and canvases or images, show no
    ribbon. The controls show the first item's values. A change goes to every selected item, each taking the fields its type has,
    as one undo step. Left out with several selected: Rotate 90° and Angle, an arrow's Labels, Reverse, Straighten, and the Shape
    picker when the shapes are of different kinds. The ribbon is placed around the box of the selected items.
  - Placement: always clear of the selection's chrome box (the selected items' outlines, every resize / edge handle, the
    rotate handle, the quick-connect dots and the group box, as drawn: §6d), 12 px beyond it: above it (rows wrap upward, the
    first row nearest it), else below it (rows wrap downward), else beside it (right, else left); else (a selection taller
    than the visible area) 12 px above or below the release point (pointer selections) or pinned to the top or bottom of the
    visible area; never over a handle, the rotate handle, a quick-connect dot or the canvas edit bar (§6b); kept inside the
    visible area and the window. Horizontally, like the Ctrl+Tab island (§7d): after a selection made with the pointer (a
    click on an item, a selection rectangle released, a spawn: §6c Spawning) its first control is at the x where the pointer
    was released (beside a tall selection excepted); the point is kept in board px, so it follows scrolling and zoom. While
    the pointer is pressed on the board (a drag) the ribbon is hidden; it comes back placed for the release point. After a
    keyboard selection (Tab, Ctrl+A, Alt+Arrow, Ctrl+Arrow, an undo that changes the selection) its left edge is at the
    item's.
  - Hidden while the item is scrolled out of view; constant on-screen size at any zoom. Controls keep fixed positions per item
    type. It stays visible while a text item is edited (§6 mid-edit rules still apply).

Dismiss-only clicks: while a transient popup is open (a select, dropdown menu or popover of any chrome except the active tool's
options flyout; the tool search palette or its options panel, §7c; the quick tools island, §7d; the native colour picker of a
colour swatch), a pointer-down on a board (a whiteboard, a canvas being edited and its artboard edges) or on a view's empty
background (§7 Background clicks) only closes the popup: no stroke, shape, placement, eraser hit, selection change, selection
rectangle, drag or focus change. The persistent chrome (rail,
the active tool's options flyout, item ribbon, canvas bars, bottom toolbar) does not count: with only it open the board works as
usual. A click on other chrome still acts at once (§7b). Popups are found in the DOM (whiteboard.js does not import the app
store); the native picker counts as open from the swatch's click until 300 ms after it closes (change, focus leaving it, the
window back in front) and ends at the first board pointer-down.

Board menu (every Board: a whiteboard, a canvas being edited, the library editor; roadmap B5): a right-click on the board opens a
menu at the pointer in place of Electron's native menu; a right-click inside the text being edited keeps the native spelling menu.
While a transient popup is open a right-click only closes it (Dismiss-only clicks: no menu, the tool stays). Otherwise it ends a
text edit, leaves the tool (an armed prefab too, §6g), selects the item under the pointer alone when that item is not selected
(inside the selection or on empty board the selection stays) and focuses the board. Entries, each with its shortcut: Create
prefab… (§6g; without a selection disabled, showing the gate's message "Nothing is selected on the board") | Cut · Copy · Paste
(the last items copied on any board; disabled until some are) · Duplicate · Delete | Bring to front · Send to back; they act as
their keys do (Cut, Copy, Duplicate, Delete and the order entries need a selection). Escape or a click elsewhere closes it and the
focus returns to the board. It is the installed dropdown menu (one open at a time, a dismiss-only popup) opened from a fixed 0 × 0
trigger at the pointer: `whiteboard.js` exports `boardMenu`, whose `open(board, {x, y})` `components/board/BoardMenu.jsx` fills.

Undo / redo started from a board or a canvas being edited (keys, rail) never scroll the document to its text selection.

Multi-selection (every board, also a canvas in edit mode):
- The selection is a set of items. A click selects one item; Shift + click adds / removes an item. Dragging on empty board area
  (outside tool modes, after 4 px) draws a selection rectangle (1 px accent border, accent at 10 % fill) and selects every item it
  touches on release (Shift: adds to the selection); it auto-scrolls like other gestures. A plain click on empty area keeps its
  old meaning (deselect; a whiteboard becomes node-selected); a click outside the board, on the view's background, deselects
  too (§7 Background clicks). Ctrl+A (board focused, not typing) selects all items.
- Several selected: each shows its selection outline, plus one dashed group box around them without resize handles; the ribbon
  is hidden (it shows for a single item only). Dragging any selected item moves all of them (snapping uses the group box; bounds
  and smart height / smart artboard apply to the group); Alt + drag copies the group; arrows nudge all; Delete removes all;
  Ctrl+J duplicates all (+20 px; the copies become the selection); Ctrl+C / X / V copy / cut / paste the group with its relative
  positions; Front / Back (rail, keys) move the group keeping its internal order; rail item actions act on the whole selection.
  Every group operation is one undo step. Escape, Ctrl+D or entering a tool mode clears the selection.

Placement tools (Text, Add canvas, Add image): nothing is added on a key or button press, only where the board is clicked.
- Text (T) and Add canvas (C, whiteboards only) are tool modes like Pen: their rail button shows active; T or the button again,
  V, Escape or another tool leave them. Cursor: text (Text), crosshair (canvas, image). Add image (I) opens the file picker;
  picked images put the board in image mode (Add image active, its button again cancels); picking nothing, Escape or another
  tool drops them.
- A pointer-down on the board (not the height bar) adds the item with its top-left at the pointer (snapped like a shape start,
  then kept inside the bounds) and the tool returns to Select: text ("Text", selected, edited at once); an empty canvas
  (artboard 800 × 450, displayed 400 × 225, edited at once, §6b); the images (the next ones +20 px each, each ≤ 60 % of the
  board width; selected). One undo step per placement. Paste and drop keep their own placement (§6b, §6).

Spawning (every board: whiteboards, a canvas being edited, the library editor): whatever adds items (a click-placed or dragged
shape, a drawn connector, a placed prefab, text, canvas or images, a shape list tile dropped on the board or double-clicked
(§6g), a quick-connect copy, pasted or duplicated items) makes the new items the selection, with their handles, and returns the
tool to Select, so the next drag moves or resizes them; the ribbon shows clear of them (above). Pen and eraser strokes stay
continuous (the tool stays on). A new text item is edited at once; a new canvas opens.

Keyboard (a board is focused and no text item or input is being typed in):
- Tools: V select, T text, I add image, P pen, E eraser, S shape, A connector, C add canvas (whiteboard); T, C and I place on the next click
  (Placement tools). Escape: end a text edit → leave the tool → deselect.
- With a whiteboard node-selected and the focus in the document (a click on its empty area), the tool keys (no Shift) go to that
  board (it takes the focus, same action); other letters go into the block after it. Letters never replace a node-selected whiteboard
  or canvas (a canvas: they do nothing).
- Ctrl+A select all. Ctrl+D deselect. Ctrl+J duplicate (+20 px). Alt + dragging an item drags a copy; the original stays.
- Delete / Backspace remove. Ctrl+C, Ctrl+X, Ctrl+V. Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z.
- Arrows nudge 1 px, Shift + arrows 10 px. Tab / Shift+Tab select the next / previous item in z-order. Enter starts editing a
  selected text item or opens a selected canvas item; Enter or F2 edits a selected text item, shape label or a selected
  connector's middle label (added if missing).
- Ctrl+Arrow: a connected copy of the one selected item that way; Alt+Arrow: the item connected to the selected one that way (§6d).
- Ctrl+] / Ctrl+[ one step forward / backward; Ctrl+Shift+] / Ctrl+Shift+[ to front / to back.
- Ctrl+Shift+; toggles snapping (master). Ctrl+' toggles the grid rule.
- R / Shift+R turn the selected shapes 90° clockwise / back; Ctrl+Shift+C / Ctrl+Shift+V copy the one selected item's style / paste
  it onto every selected item (§6d).

---------------------------------------------------------------------------------------------------
## 6b. Smart canvas (src/canvas.js)

A whiteboard contained in an insertable, resizable object. In the document it is a scaled picture; it is edited in place, at
its spot in the post (artboard, the whiteboard tools; In-place canvas editing below). It exports as one image at its document size.

Node `canvas`: group block, atom, selectable, draggable false; inserted at the top level (`insertBoard`).
Attrs (all `rendered: false`): `w`, `h` (artboard size in px, default 800 × 450), `dw` (display width in the document in CSS px,
default = w), `frame` (smart artboard below, default null), `bg` (as whiteboard, default 'post'), `items` (same item shapes as
§6, coordinates relative to the artboard), `flow` (null, or `{id, rev}` for a canvas synced with a library flowchart, §6f;
invalid → null), `source` (null, or `{format: 'mermaid', text}`: the Mermaid text an import filled it with, §6d Formats; invalid →
null).
`parseHTML: div[data-canvas]` reading JSON from `data-json` (same validation as `parseBoard`, so connectors and labelled or turned
shapes too, §6d; non-finite or ≤ 0 sizes → defaults;
a frame with a non-finite number or w / h ≤ 0 → null);
`renderHTML: ['div', {'data-canvas':'', 'data-json': JSON.stringify(attrs)}]`. Command `insertCanvas(attrs?)`.
Exports: `Canvas` (Node, added to `buildExtensions`), `openCanvasEditor(editor, pos)` (enters edit mode for the canvas node at `pos`),
and the stores the React chrome follows: `canvasEditor` (`get()` → the edit mode session of the canvas being edited or null, `subscribe(fn)`) and `activeCanvas`
(`get()` → `{view, dw, w, h}` of the canvas the document bar serves, `subscribe(fn)`).

Smart artboard (every canvas: the document canvas node and canvas items; overrides the §6 Bounds bullet and the fixed-size
rules for canvases; whiteboards keep their bounds and smart height):
- Items may be drawn, moved, resized, pasted and typed past any artboard edge (pen and shape points are no longer clamped to
  the artboard). The artboard follows the content in all four directions, so nothing is ever cut off.
- `frame` = the artboard the user chose: `{x, y, w, h[, item]}` in artboard px, or null = the whole current artboard (old drafts).
  `item` binds the frame to one item: the frame then always equals that item's box (it follows moves, resizes and crops), so
  the canvas of an image moves with the image instead of leaving its old spot empty. An image converted to a canvas, a pasted
  image canvas and Fit to content with a single item bind it; W / H and the edge drag unbind it; deleting the item unbinds it
  where it was. On load, a frame without `item` that exactly equals the box of a canvas's only (non-text) item binds to it.
  It is set by a new canvas (800 × 450), an image converted to a canvas (the image's size), the W / H inputs, the artboard
  edge drag and Fit to content. The content box C = the union of all item boxes (text: rendered height; strokes and shapes:
  their padded boxes).
- Artboard = the frame, extended on each side where C goes past it to C's edge plus 32 px of padding. Content inside the frame
  never adds padding, so an image that fills its canvas keeps its exact size.
- After the artboard is computed it is normalised to start at 0,0: when it grew to the left or top, every item and the frame
  shift right / down by that amount (and back when it shrinks). A canvas item on a whiteboard keeps its content in place: its
  x / y move by the scaled growth on the left / top (clamped to the whiteboard; In-place canvas editing below) and its displayed
  size grows with the artboard at the same scale (capped to the whiteboard width; when capped the scale shrinks). The document
  canvas keeps its place and its scale (`dw` grows with `w`, capped to the content width).
- The artboard shrinks again when content that made it grow is moved back, made smaller or deleted: never smaller than the
  frame. It grows and shrinks live during a gesture (the item stays under the pointer as far as the canvas can follow, auto-scroll
  near the editor area's edge keeps working) and is committed with the gesture: one undo step.
- W / H inputs show the current artboard size; editing one sets the frame to {0, 0, W, H} (minimum 40), and the artboard then
  still includes the content beyond it plus padding (so a value below the content snaps back). Dragging the artboard's right /
  bottom edge sets the frame the same way. Fit to content sets the frame to C (items shifted to start at 0,0) with no padding.
- Export and the document / whiteboard previews show the whole artboard.
- A canvas item that grows taller pushes the whiteboard items under it down by the growth (every item starting at or below its
  old bottom that shares columns with it, transitively), so it never covers them; shrinking does not pull them back (undo does).

Canvas items (a smart canvas inside a whiteboard):
- A whiteboard can hold canvases as items: `{id, type:'canvas', x, y, w, h, aw, ah, frame, bg, items}`. x / y / w / h = place and
  displayed size on the board (like an image); aw × ah = artboard size in px; frame and bg as for the canvas node; items = the
  canvas's own items (image, text, stroke, shape, connector; never another canvas), coordinates relative to the artboard. parseHTML drops a
  canvas item with a non-finite number or aw / ah ≤ 0, turns an invalid frame into null, filters its items like a board's
  (connector ends repaired among them, §6d) and drops a `flow` attr (a library link exists on the canvas node only; a canvas
  item is never synced).
- `itemElement` draws it as a clipped box (background = resolved bg) holding the artboard (aw × ah, scaled by w / aw) with
  `itemElement` for every inner item. The document canvas preview uses the same code, and the rasterizer therefore exports a
  canvas item together with its whiteboard.
- On the board it behaves like an image: select, move, snap, bounds, duplicate, copy / paste, layer order, delete. The corner
  handles change the displayed size with the aspect always locked (no free resize, no crop).
- Double-click, Enter while it is selected, or the ribbon's Edit edits that item in place (below): the same edit mode, rail,
  ribbon and keys as for a document canvas. W / H edit aw × ah; the displayed size keeps its ratio to the artboard
  (`w' = w · aw' / aw`, capped to the parent board's width). Every change is committed through the parent whiteboard node (one
  document history, the same undo limit). Edit mode ends when the item or its whiteboard disappears.
- Double-clicking an image item on a whiteboard turns it into a canvas item in one undo step and edits it in place: artboard = the
  natural pixel size of the image's visible (cropped) region, the image is its only item and fills the artboard (crop kept), and
  the canvas takes the image's place and displayed size, so nothing moves on the board.
- Rail: the anchored `Add canvas (C)` slot is a placement tool (board mode, §6c): a click on the whiteboard adds an empty canvas
  item there (artboard 800 × 450, displayed 400 × 225, top-left at the click) and edits it. While a canvas is edited that slot is disabled and an image double-click in it does
  nothing: canvases do not nest.
- Ribbon for a selected canvas item: Edit, Reset size (displayed size = artboard size, capped to the board).

Document NodeView (`.sc`):
- Block, left-aligned, `width: min(dw px, 100 %)`, `aspect-ratio: w / h`, margin 1em 0, background = resolved bg for the theme.
  Inside, `.sc-art` (w × h px, `transform-origin: 0 0`, `transform: scale(drawn width / w)`, overflow hidden, pointer-events none)
  holds `itemElement(item)` for every item. The scale follows the drawn width (ResizeObserver). The preview itself is never
  edited: edit mode draws a live Board over it (below).
  An empty canvas shows a dashed outline and the hint "Empty canvas. Double-click to edit.".
- Click → node selection. Unselected, it shows the pointer (hand) cursor and the hover hint (below). Selected: 2 px outline and four corner handles; dragging a corner changes `dw` (aspect locked, zoom-aware,
  40 px ≤ dw ≤ content width; east handles grow to the right, west handles grow when dragged left); live DOM update, one commit on
  pointerup.
- Bar (`<CanvasBar/>`, one instance in App, fixed-positioned at the top-right of the node-selected canvas only, never on hover
  (above it when the canvas is too small to hold the bar), following it; buttons never take focus): `Edit`, size label `<dw> × <round(dw·h/w)>`, `Actual size`
  (dw = min(w, content width)), `Full width` (dw = content width), `Delete`; before Delete, Open in library and Unlink for a
  synced canvas, Save to library… for any other (§6f).
- Double-click, `Edit`, or Enter while node-selected → in-place canvas editing (below). Typed letters do nothing (never replace it).
- Hover hint (`<HoverHint/>`, src/app/components/HoverHint.jsx, one instance in App; also plan charts §6e and whiteboards §6):
  when the pointer rests on an unselected document object for 700 ms without moving more than 4 px, a small hint shows what a
  click and a double-click do, 14 px right of and 22 px below the pointer (kept 8 px inside the window, flipped above the
  pointer at the bottom edge, never over the 34 px title strip), in the shared tooltip look (`bg-foreground/80`,
  `backdrop-blur-sm`, `text-xs`), click-through. Texts: canvas "Click to select. Double-click to edit.", synced canvas "Click
  to select. Double-click to edit the flowchart.", a canvas holding just one image "Click to select. Double-click to edit the
  image.". Each NodeView answers `hint(target)` (null once selected or in use); the component reaches it through the node's
  element (`scView`, `pcView`, `wbView`), inside `.ProseMirror` only. A move beyond 4 px, pointer down, wheel, scroll, a key
  press, window blur or the pointer leaving the window hides it; nothing shows while a canvas is being edited.
- `update(node)`: re-render; while it is being edited the live Board receives the new attrs. `destroy()` ends its edit mode.
  `stopEvent` → true except paste/drop events, `ignoreMutation` → true.

In-place canvas editing:
- Double-click, `Edit`, or Enter on a node-selected canvas (document canvas or canvas item) enters canvas edit mode in the same
  editor viewport. The canvas turns into a live fixed `Board` at exactly its spot and display scale in the post (document canvas:
  drawn width / w; canvas item: item.w / aw; times the page zoom), so nothing on screen jumps: the Board is drawn inside the page
  over the canvas, whose preview is hidden meanwhile, and keeps that scale until edit mode ends (item sizes there are in post px, §6c Units). Everything else in the document
  is dimmed (about 45 % opacity) and inert while editing (pointer-events none on it; the canvas and its chrome stay fully
  interactive).
- Pan and zoom are the main view's (§7: wheel, middle-drag, Ctrl + wheel around the pointer, slider). There is no separate zoom.
- The §6c rail is in board mode for the canvas board; the ribbon, the quick tools (§7d) and the tool search (§7c) work as on any
  board. Entering edit mode shows the §7c notice "Canvas Mode" (frame icon) as a mode notice: a slightly larger pill (16 px text, 20 px icon), on a 40 % opaque card
  background, in the §7c notice stack above the toolbar island (decision: it moved there from the viewport's centre with the
  other notices; it can go back to the centre if wanted), clicks go through it; shown at once, fully visible for 2 s, fading out over the third second (§7c). Leaving it
  shows nothing, and no other mode change shows a notice. A small floating bar attached above the canvas (like the canvas bar, buttons never take focus): `W`, `H` (integers,
  40…8000; they set the frame), `Fit to content`, `Done` (primary).
- The post never moves while editing: moving or drawing inside the canvas moves only that content on screen. Smart artboard growth
  (above) shows live in place: growth to the right / bottom extends the canvas in place (when the change is committed the post
  reflows; a canvas item grows on its whiteboard and pushes the items under it, as above); growth to the left / top: a canvas
  item moves left / up on its whiteboard by the scaled growth (clamped at the whiteboard's left / top edge) so its content stays
  put on screen; a document canvas cannot move left of the post's content edge (or up), so its content shifts right / down by the
  clamped part, live (the dragged item then stays at the canvas edge instead of under the pointer). A frame bound to an image
  follows it: dragging the only image of an image canvas moves the canvas item on its whiteboard (the post stays still); no
  snapping to that frame, which is the image's own box.
- Artboard resize: drag the canvas's right edge, bottom edge or bottom-right corner while editing (zoom-aware; sets the frame,
  40…8000; live; one commit on pointerup); `dw` / the item's displayed width keep their scale (capped to the content / whiteboard
  width).
- Keys while editing (no text item or input being typed in): the §6c keyboard set; undo / redo as on whiteboards (document
  history, never scrolling); Escape: end a text edit → leave the tool → deselect → leave edit mode, one step per press.
- Paste / drop: a copied board item or image files go into the canvas while it is being edited (images at the centre of its
  visible part, drops at the drop point). Else a paste adds the items of smart canvases and whiteboards copied from a
  document (an image block is a canvas; sizes converted, §6c Units), else the text as a text item, centred in the visible
  part (`Board.pasteClipboard`, also a focused whiteboard's and the library editor's paste).
- Every change is committed live to the document (same autosave and undo history as §6).
- Edit mode ends with `Done`, the final Escape, a left pointer-down in the main column outside the canvas and the board chrome
  (that click does nothing else: no caret, no button action; the sidebar, the status bar's zoom, dialogs and the assistant's
  panel and button keep working),
  switching or creating a draft, or the canvas disappearing (undo, delete). It returns to the normal view with the canvas
  node-selected (a canvas item: selected on its whiteboard).
- While editing, the document shortcuts (Ctrl+K, Ctrl+\, Ctrl+Alt+W, Ctrl+Alt+C, Alt+1…9) are off; Ctrl+S, the window zoom keys, the
  tool search and the quick tools work as usual.

---------------------------------------------------------------------------------------------------
## 6d. Flowcharts: shapes, connectors, labels (src/flow/*.mjs)

Roadmap B1 built the data model, rendering and routing below; roadmap B2 the connector tool, label editing, connector handles and
quick-connect (Editing, below); roadmap B3 the shape list, rotation, arrangement and style (Arrangement and rotation, below);
roadmap C2 obstacle avoidance and line jumps (Routing, Line jumps, below); roadmap C3 Mermaid import / export, auto-layout and Copy
as PNG (Formats, below).

No new node: a flowchart is a canvas (or a whiteboard) whose items include labelled shapes and connectors (the per-thread library
and canvases synced with it: §6f). The logic lives in pure
modules (no DOM, Node-tested): `src/flow/shapes.mjs` (shape registry, outlines, rotation), `src/flow/route.mjs` (routing, heads,
label anchors), `src/flow/model.mjs` (validation, defaults, repair, move / clone / hit-test, align / distribute / same size, the
turned resize), `src/flow/graph.mjs` (board items ↔ graph), `src/flow/mermaid.mjs` (Mermaid text ↔ graph), `src/flow/layout.mjs`
(dagre auto-layout).

Shape kinds: the registry `KINDS` (44 kinds); each kind's `path(w, h, inset) → {d, poly}` is in item px (`poly`: the outline
connectors attach to and hit-tests use), with a label, a group and search keywords. Basic: Box (`rect`), Rounded box, Circle,
Triangle, Star, Arrow, Line, Thought bubble, Speech bubble (these 9 still drawn by shapeGeometry), Pentagon, Octagon, Plus, Cross,
Cloud. Flowchart (Mermaid v11 ids): Terminator `stadium`, Decision `diam`, Data `lean-r`, Data (reversed) `lean-l`, Document `doc`,
Multi-document `docs`, Subroutine `fr-rect`, Preparation `hex`, Manual input `sl-rect`, Manual operation `trap-t`, Priority
`trap-b`, Display `curv-trap`, Stored data `bow-rect`, Database `cyl`, Direct access `h-cyl`, Internal storage `win-pane`, Delay
`delay`, On-page connector `sm-circ`, Off-page connector `off-page`, Loop limit `notch-pent`, Summing junction `cross-circ`, Or
`or-circ`, Collate `hourglass`, Sort `sort`, Card `notch-rect`, Tape `flag`, Annotation `brace`, Fork/join bar `fork`. Containers:
Swimlane `lane` (a 28 px title band holding the label) and Frame `frame` (dashed outline, label top-left). Line and arrow have no
outline and attach on their box; the Annotation is an open curly brace (never filled; it attaches and hit-tests on its box, its
label left-aligned beside the brace). A click-placed shape is 160 × 110 post px, or its kind's own size: Swimlane 900 × 180,
the three small circles 60 × 60, Off-page connector 80 × 80, Collate 80 × 100, Fork/join bar 160 × 14.

Shape fields, all optional:
- `rot`: degrees clockwise, normalised to [0, 360) by parseHTML (non-finite: dropped). The shape turns about its box centre
  (`transform: rotate()` on its element, label and outline included; the export is identical); x y w h stay the unrotated box.
  Every box-based Board computation uses the turned bounds: snapping, the group box, marquee, the content box (smart artboard,
  smart height), clamping into a whiteboard, a canvas frame bound to the shape, align / distribute. Turning and resizing a turned
  shape: Arrangement and rotation, below.
- Label: `html` (the text-item content rules; '' or absent = none), `size` (default 16; post px in the chrome, §6c Units),
  `textColor` (default '#ffffff'), `bold`, `align` (left | center | right; default center, a frame left), `valign` (top | middle |
  bottom; default middle, a frame top). parseHTML drops a field of the wrong kind; a missing one takes its default when drawn. The
  label box is the shape's box inset by its kind's `labelInset` (8 %, a diamond 20 %; a lane: its band); only the words take the
  pointer, so an unfilled interior stays click-through.

Connector item:
- `from`, `to`: bound `{item, anchor}` or free `{x, y}` (board px). `anchor` null = floating: the end sits where the ray from the
  item's centre toward the other end (its free point, fixed anchor or centre; or the nearest waypoint) leaves the item's turned
  outline. `anchor` `[rx, ry]` (0..1 of the unrotated box) = fixed: turned with the item, then moved from the centre onto its
  outline (a box corner lands on a diamond's edge). Anchor names n e s w ne nw se sw c are converted (`cleanConnector`); a stored
  item that never went through it (hand-written JSON such as the eval fixture) is routed with the name's fraction too (route.mjs
  `endOf`, 2026-10-07; before, a name routed to the item's centre). Ends never bind to connectors.
- `route`: straight | ortho (default) | curve; `corner`: ortho elbow radius (default 8); `points`: waypoints in board px (at most 32;
  the path passes through each); `heads {start, end}` ∈ none · arrow · triangle · triangle-open · diamond · diamond-open · circle ·
  circle-open · bar · cross · one · many · one-many · zero-one · zero-many · exactly-one (default none / arrow); `color` (default
  '#ffffff'), `width` (default 2; post px in the chrome, §6c Units), `opacity` (1), `dash` solid | dashed | dotted, `jump` none | arc
  | gap (default none; line jumps, Routing below).
- `labels {start?, mid?, end?}`: each `{html, t, dx, dy, size, textColor, bold}`; `t` = fraction of the path from `from` (defaults
  0.15 / 0.5 / 0.85, clamped to 0..1), `dx, dy` = offset in px from that path point, `size` default 14, `textColor` '#ffffff'. A slot
  without a non-empty `html` is dropped; a string `label` (agent sugar) becomes `mid`.
- Derived, written by `resolveConnectors` on every Board render and commit, and by the renderers for any connector without a `d`:
  `x y w h` (bbox of the path, heads, jump arcs and labels, padded by width / 2 + 1), `d` (the shaft in bbox px, stopped short of
  each head as the head needs, line jumps spliced in), `tips` ([{x, y, a}] per end in bbox px; `a` = the direction the tip points, degrees), `lps` (label anchor per
  present slot, bbox px). Rendering never needs the siblings. parseHTML keeps them only when all are valid.
- Routing. Straight: the polyline through the waypoints. Ortho:
  axis-aligned; a bound end leaves along the board axis closest to its anchor's turned normal with a stub that reaches 20 px past
  the item's turned bounds (on an unturned box side: 20 px; two facing ends closer than their two stubs: half their gap each, but
  never ending inside their own bounds); a floating ortho end leaves from the side facing the other end. Ends slide along their
  side so runs are straight, never a micro-jog: two facing bound ends without waypoints are one straight segment when they can
  share a coordinate across their normal (the source's, else the target's, else, both floating, the middle of the overlap of the
  two outlines' extents), and otherwise an end lines up with its waypoint or the other, free end; a floating end slides anywhere
  inside its outline's extent (else it stays at the middle of its side), a fixed port at most max(4, 2 × line width) px (a
  nearly aligned port pair snaps straight; a larger offset keeps its elbow); a coordinate a floating end picks is whole px for an
  even line width, half px for an odd one; waypoints never move. Between the stubs and through the waypoints each leg takes the shape with the fewest turns that never turns back and never passes through the
  turned bounds of the connector's own two items (straight, a centred Z, an L, then a detour around both items' bounds; when every
  one of these passes through a box, the fewest-turn, then shortest, path on a grid of lines through the leg's ends and 20 px
  outside each box; a box that holds the leg's own start or end, e.g. a waypoint placed inside it, does not count for that leg);
  other items are not avoided. Corners are rounded by `corner` (the tips do not move). Curve: cubic Béziers through the waypoints
  (Catmull-Rom); a bound end leaves along its normal. A connector whose two floating ends sit on one item (a self-loop, no
  waypoints) leaves that item's east side middle and comes back into its north side middle (elbow: 4 segments).
- Line jumps (`jump` arc | gap; straight and elbow routes only): where a jumping connector crosses a straight or elbow connector
  below it in z-order, its line jumps: a 6 px-radius half circle (bulging up; a vertical line bulging left) or a 12 px gap,
  centred on the crossing. Z-order decides: only the upper line jumps, and only when it has `jump` set; curves neither jump nor
  are jumped; lines that only touch or run along each other do not jump. A jump needs 6 px clear of a rounded corner and 12 px
  from the previous jump, else it is left out. While any connector on a board jumps, every routing pass re-routes all of its
  connectors (a moved line changes the jumps over it, live too). Crossings are found by a sweep over x with a bounding-box
  prefilter; a pass tests at most 20 000 segment pairs (crossings not reached get no jump), and a commit that hits the cap shows
  the toast "Too many crossing lines: some line jumps are not drawn" (one at a time, never stacked).
- Rendering (`itemElement`, so the Board, the canvas preview and the rasterizer draw it the same): an SVG the size of the bbox with
  the shaft (dashed `4w 3w`, dotted `0.1 2.5w`, round caps), one head path per end (filled heads in the line colour, open heads
  stroked; the ER circles cut the shaft and the head draws the line on to the tip, so no board colour is needed), a transparent
  hit path (at least 14 post px, like strokes) and one label per present slot centred on its anchor (2 / 4 px padding, no wrapping,
  background `var(--wb-bg)`: the resolved board background, set by CSS per `data-bg` on a Board and inline by drawCanvas and the
  rasterizer, so a label masks the line; transparent boards show the line through). Only the line and the labels take the pointer,
  never the bbox.
- Parsing: parseHTML keeps a connector with valid ends and, where present, valid enums, numbers and points, and fills the defaults.
  Ends bound to an item that is not there are repaired by parseBoard, the canvas-item branch and resolveConnectors: (a) free at the
  stored tip; (b) without tips, free 100 px right of the other end (its item's centre or point); (c) neither: the connector is dropped.

Board behaviour (existing gestures; one commit is one undo step, as before):
- A connector is selected by its line or a label (click, Shift + click, Tab, Ctrl+A, the selection rectangle); selected, its line
  glows in the accent colour instead of a box outline, and a single selected connector shows its handles (Editing, below) instead of
  corner handles (its box is derived).
- Moving, resizing or cropping items re-routes the connectors bound to them, and a moved connector moves its free ends and waypoints
  (bound ends stay on their items); live during the gesture (only those connectors are redrawn), stored by the commit. A gesture that
  changes only ends, waypoints, labels or `rot` still commits.
- The selection rectangle selects a connector when its line touches the rectangle, not its bbox.
- Delete: connectors bound to a removed item stay, their ends free where they were. Duplicate, Alt + drag copies and paste: a
  connector between copied items binds to the copies; an end bound outside the copied set becomes free at its tip. Nudging and the
  smart-artboard shift (and the push-down under a grown canvas item, §6b) move free ends and waypoints with their connector.
  Pasting onto a board of another unit (§6c Units) also scales free ends, waypoints and label sizes and offsets.
- The smoke sample (src/app/samples/flow.js, spread into the sample document) adds a 1200 × 675 canvas (dw 600) with six labelled
  shapes (a diamond turned 30°, a swimlane) and eight connectors stored unrouted: every route, waypoints, labels in all three slots,
  every head kind; then a synced canvas whose library record is missing (§6f Smoke).

Editing (roadmap B2; one commit is one undo step):
- Connector tool (A; rail slot Connector after Shape, §6c). Options: route (Straight · Elbow = ortho · Curve), start and end head (a
  button showing the head; its popover holds the 16 kinds, each drawn by the board's own head geometry), line colour + width, style,
  dash, line jumps (No jumps · Arc · Gap; new connectors take it); shared and kept (§6c Tool settings); an unset colour is the theme's ink ('#ffffff' dark, '#111111' light) when a connector
  is made. Insert flowchart and opening a flowchart in the library editor (§6f) apply the flowchart preset (`flowPreset`): shape tool Box
  filled with the theme's card colour (#3a3b46 / #f0f0f4), line and label in ink, 2 px, label 16 px, and the connector colour ink;
  it stays until changed.
- Drawing: a drag draws a connector from where it starts to where it is released; a preview routed against the items follows the
  pointer, and the canvas artboard or whiteboard grows to hold it. Shorter than 8 screen px adds nothing (a click adds nothing). The
  new connector becomes the selection and the tool returns to Select (§6c Spawning).
- Sticking: an end over an item (topmost first; strokes and connectors never) sticks to it: within 12 screen px of one of its ports
  (side middles and corners, on its turned outline) to that port (fixed anchor), else anywhere inside its turned outline (unfilled
  interiors too) floating. Otherwise the end is free, snapped like a shape point (Ctrl: no snapping) and kept inside a whiteboard.
  Alt held: no sticking. While the tool is on (hovering or drawing) and while an end is dragged, the item it would stick to shows a
  dashed accent outline and its port dots, the port in use filled (editor only, never exported).
- Handles of a single selected connector: one per end (filled while it sticks); a square one on each inner segment of an elbow route
  (the first and last segments hold the ends' stubs and move with the ends) or, on a straight or curved route, halfway along each
  stretch between its ends and bends; a round one per bend (waypoint). Its labels lie over those handles. Drag an end: it re-sticks
  or becomes free. Drag an elbow segment handle: the segment moves across (snapped to other items' edges and centres), its two
  corners become bends (bends on it move with it) and the route re-flows on both sides. Drag a straight / curve segment handle: a new
  bend at the pointer. Drag a bend: it moves (snapped); double-click it: it goes. After a segment or bend drag, a bend within 2 px of
  the line between its neighbours goes. An end re-stuck with an unchanged box still commits.
- Ribbon of a selected connector: route, heads, colour, width, style, dash, line jumps, Labels (popover), Reverse (ends, heads and bends swap;
  every label keeps its place: `t → 1 − t`, start and end slots swap), Straighten (removes the bends; disabled without). Reverse and
  Straighten act on every selected connector.
- Shape labels: double-click inside the shape (also where it is unfilled, when no other item takes the pointer there), or Enter / F2
  on the selected shape, edits its label in place (contenteditable, text-item rules; an empty label gets the theme's text colour and
  16 post px). Typing past the label box grows the shape's height; its connectors follow live. A label left empty is removed. Ribbon:
  Label popover (size in post px, text colour, bold, align, vertical align).
- Connector labels: double-click a label edits it; double-click the line edits the slot by where it was hit (start below 25 % of
  the path, end above 75 %, else middle), adding a missing one there ("Label", selected so typing replaces it; the middle one snaps
  to 50 % within 10 %; the theme's text colour, 14 post px). Enter / F2 on a selected connector edits its middle label (added if
  missing). A label left empty is removed. Dragging a label moves only it, along the path (`t`) and beside it (`dx`, `dy`; the pointer
  keeps its grip); released within 8 screen px of the line it sits on it. Labels popover: one row per slot (Source, Middle, Target)
  with a switch (on adds the label and edits it, off removes it) and Edit; the chosen row shows that label's size, text colour and
  bold. Typing a letter never starts a label (letters are tool keys).
- Typing a label (shape or connector): Enter adds a line (contenteditable's `<div>` lines; the connector bbox estimate counts them
  as `<br>` lines, a line-ending `<br>` being only a placeholder). The label grows around its anchor (a connector label centred on
  its path point, a shape label by its align / valign) and nothing else moves, the view included: the text being edited has
  `overflow-anchor: none` (Chromium otherwise anchors the scroll on the focused editable and scrolls the view by half of each new
  line). A connector label is re-routed and the artboard re-fitted only at the commit: a label that then reaches past a canvas's
  artboard grows it once, the content kept in place on screen (§6b smart artboard).
- Quick-connect: a single selected item (not a stroke or connector) shows four dots 14 screen px outside its side middles (children of
  its element: they turn with it). Drag a dot: a connector from that side (fixed anchor) to where it is released, sticking as above
  (never to the item itself). Click a dot, or Ctrl+Arrow: a copy of the item 60 post px past its side facing that way (on a turned
  shape the side whose turned normal is closest; a whiteboard keeps it inside), joined from that side to the copy's opposite side by
  a connector in the tool's style; the copy becomes the selection, so the next Ctrl+Arrow goes on from it. Alt+Arrow selects the item
  joined to the selected one by a connector that lies most that way (smallest angle, then the nearest; nothing when none). Releasing
  Alt after Alt+Arrow or a non-sticking drag does not open the window menu.
- `window.__smokeFlow()` (src/app/flows.js; run after `__smoke()`): edits the sample flowchart in place, stores its routes, moves a
  shape a connector sticks to 80 px right, commits and returns `{moved, tipsChanged, pngChanged}` (the stored connector geometry and
  the canvas PNG changed).

Arrangement and rotation (roadmap B3; one commit is one undo step):
- Shape list: the Shape control of the shape tool's flyout, the quick tools island, the tool search's options and the shape ribbon
  is a button showing the kind (preview and name); its popover holds a search field (focused; it matches names and keywords like
  the tool search) and every kind as a tile with its preview drawn by the board's own geometry, in sections Basic, Flowchart and
  Containers (registry order). Typing filters; Enter picks the focused tile, or in the search the best match (ranked as the tool
  search ranks, ties in list order; also inside the tool search's options panel, whose Enter would close it); Down goes from the
  search to the first tile; arrows move between tiles (Up / Down: the nearest tile in the row above / below; Up from the top row: the
  search); Escape closes. In the flyout it sets the shape tool's kind, in the ribbon the selected shape's.
- Rotate handle: a single selected shape shows a round handle 18 screen px out from its top-right corner (a child of its element, it
  turns with it; on a shape at a whiteboard's edge it can be clipped, R and the angle field still work). Dragging it turns the shape
  about its centre by the angle the pointer turns, in whole degrees; Shift: 15° steps. Bound connectors re-route live; the ribbon's
  angle follows; on a whiteboard the turned box is kept inside.
- R turns every selected shape 90° clockwise about its own centre, Shift+R 90° back; the ribbon's Rotate 90° button too. The ribbon's
  Angle field (0–359, step 1) sets every selected shape's angle as it is typed (the history merges quick changes); Enter or Escape
  returns the focus to the board. Several shapes always turn each about its own centre.
- Edge handles (shapes): n, e, s, w at the side middles move one side only (no aspect rule; snapped while not turned).
- Resizing a turned shape (corner or edge handle) works in its own frame: the pointer's move turned back by the angle, the box
  resized with the opposite corner (edge middle) fixed and placed so that point keeps its place on the board; Shift keeps the aspect
  (corners); no snapping and no size cap while turned; a whiteboard then pulls the turned box back inside.
- Arrange (rail slot after Send to back, its menu; enabled from two selected items, gate `board.selectionMany`; also tool search
  entries): Align left / centre / right / top / middle / bottom (onto the selection's bounds), Distribute horizontally / vertically
  (equal gaps, in position order; the outermost stay; fewer than three: nothing), Same width / Same height (the largest among them; a
  turned shape keeps its centre, others their top-left). Items count by their bounds (a turned shape: its turned box); connectors are
  left out (bound ends follow), and for Same size canvases (they keep their aspect) and, for the height, text.
- Style presets: 10 paired swatches (the registry's `STYLE_PRESETS`: draw.io's 8 fill / line pairs with dark text, then the theme's
  card / ink and transparent / ink) in the shape and connector flyouts and a Style presets popover in the shape and connector ribbons.
  A click sets a shape's fill (transparent: no fill), line and label colours, or a connector's line colour.
- Style copy / paste (board focused): Ctrl+Shift+C copies the one selected item's visual keys (shape: line colour, width, style, fill,
  fill colour, label size, colour, bold, align, vertical align; connector: route, corner, heads, colour, width, style, dash, line jumps and each
  label's size, colour and bold; text: size, colour, bold, align, note; stroke: colour, width, style) into a clipboard shared by all
  boards; Ctrl+Shift+V gives every selected item the copied keys its type has (sizes converted between units, §6c Units; a connector
  label takes the copied style of the same slot).
- Containers: dragging a Swimlane or Frame (not with Alt, which copies) moves along everything that lies fully inside its bounds at
  the start of the drag (items by their turned bounds, connectors by their box, so their bends move too). Nothing is re-parented.

Formats (roadmap C3; the pure modules are Node-tested in `test/flow-mermaid.test.mjs` and `test/flow-layout.test.mjs`, the app side
is `src/app/flows.js`; one commit is one undo step):
- Graph (`graph.mjs`, flowchart plan §3.7): `{dir, nodes: [{id, kind, label, x, y, w, h, rot?, style?}], edges: [{id, from, to,
  label?, startLabel?, endLabel?, heads, dash, route, thick?}], groups: [{id, kind: frame | lane, label, members}]}` in post px,
  labels as plain text ('\n' a line break). `toGraph(items, {unit, preset})`: shapes, text, images and canvases are nodes (kind =
  the shape kind or the item type); swimlanes and frames are groups whose members are the items inside their turned bounds (the
  innermost group only); connectors bound at both ends to nodes or groups are edges (2 post px; 3 or more: thick); `dir` is the
  direction most edges run in; a shape's `style {fill, stroke, text}` holds the colours that differ from the theme's flowchart
  preset. `fromGraph(graph, {unit, preset, taken})`: unfilled frames or swimlanes (outer first, so behind), shapes in the flowchart
  preset (Editing, above) unless a node has its own colours, text items for kind `text`, a box for a kind the registry does not
  have, floating elbow connectors in ink (2 post px, thick 4; labels 14 post px); item ids are the graph ids unless taken. A node
  without a size gets one for its label (at least 140 × 64 post px, at most 280 wide, then wrapped, within its kind's label inset;
  circles square; kinds with their own size keep it); when any node has no position the graph is laid out (below).
- Mermaid (`mermaid.mjs`): `parseMermaid(text)` → `{graph, warnings}`, or `{error: {line, col, message}}` for the first problem
  (1-based). It reads `flowchart` / `graph` with TB | TD | BT | LR | RL (default TB); nodes `id`, or with a bracket shape: `[ ]` Box,
  `( )` Rounded box, `([ ])` Terminator, `[[ ]]` Subroutine, `[( )]` Database, `(( ))` and `((( )))` Circle, `{ }` Decision, `{{ }}`
  Preparation, `[/ /]` Data, `[\ \]` Data (reversed), `[/ \]` Priority, `[\ /]` Manual operation; or `id@{ shape: …, label: "…" }`
  with the Mermaid v11 shape names and their aliases (the registry's flowchart kinds are named by them; `tri` is Triangle, `text` a
  text item; an unknown shape, and `>…]`, import as a box with a warning). Labels plain or quoted, with `<br>` and entity codes
  (`#quot;`, `#35;`). Links `-->`, `---`, `-.->`, `-.-`, `==>`, `===`, `--o`, `--x`, `<-->`, `o--o`, `x--x` of any length (heads
  arrow / circle / cross, dotted, thick; as in Mermaid an `o` / `x` right after the line is a head even when glued to the next
  id, `A---oB`), labelled `-->|yes|` or `-- yes -->` (`-. yes .->`, `== yes ==>`); `~~~` makes no
  connector; chains and `&`. `subgraph id [title]` or `subgraph title` … `end`, nested (`direction` inside is kept in the graph but
  not used by the layout); a node belongs to the innermost subgraph it is first mentioned in; a subgraph id used twice is an error. `classDef`, `class`, `:::` and `style`
  (fill, stroke, color; `classDef default` applies to every node) set the node's colours. `%%` comments; `click`, `linkStyle`,
  `accTitle` and `accDescr` are skipped with a warning. At most 1 MB of text. `toMermaid(graph)` → `{text, warnings}`: subgraphs
  (with their `direction`) holding their members, the other nodes, then the links, then one `classDef` + `class` per distinct
  style; bracket shapes where Mermaid has them, else `@{ shape }`; ids that are not plain Mermaid ids (or are keywords) become n1,
  n2, …; labels quoted when needed. Lossy, each a warning: start / end labels (Mermaid has one label per link), rotation, kinds
  Mermaid does not have (→ box), heads other than arrow / circle / cross (→ arrow), a start head that does not mirror the end head
  (left out), swimlanes (→ subgraphs). `isMermaid(text)`: its first line that is not blank or a `%%` comment is `flowchart` or
  `graph`, optionally with a direction.
- Layout (`layout.mjs`; `@dagrejs/dagre` ^3.1.1, bundled): `layout(graph, {dir, nodesep: 40, ranksep: 60})` → the nodes' top-left
  positions and the groups' boxes (compound clusters around their members; an edge to a group goes to one of its member nodes; a
  group holding no nodes is laid out as a node of its size, inside its own group if any), synchronous; a turned node takes its turned bounds; more than 500
  nodes, or a node without a position: `layout_failed`. Edge points from dagre are not used: the board's router draws the
  connectors.
- Import diagram… (tool search; the dialog: §7): in the text, a new canvas after the selection holding the diagram (artboard = the
  drawing + 40 px on each side, `dw` = min(w, the content width)), edited in place. On a board (a whiteboard, a canvas being edited,
  the library editor) the diagram is added, selected, centred on the board's visible part, or, with "Replace board contents" or
  on an empty board, 40 post px inside its top-left (a canvas: its frame's); a whiteboard shrinks a wider diagram to its width and
  keeps it inside. Mermaid text pasted onto a focused or node-selected whiteboard, or onto a canvas being edited, opens Import
  diagram with the text; a paste into a text being edited, an input or a textarea is a plain paste. At most 1000 items.
- Source: an import that makes or fills a whole canvas (a new one, Replace, or an empty one) keeps the text as the canvas attr
  `source: {format: 'mermaid', text}` (§6b), and in the library editor or on a synced canvas also as the record's `source` (§6f);
  Save to library, Duplicate and Insert flowchart carry it along. It is not changed by later edits; nothing reads it yet (agents,
  roadmap C4).
- Auto layout (tool search; options only: Top to bottom, Left to right, Bottom to top, Right to left): the board's nodes and groups
  are laid out from where the diagram began (its top-left stays); swimlanes and frames are resized around their members;
  connectors between laid-out items lose their bends and re-route; a whiteboard shrinks a wider result to its width.
- Copy as Mermaid (tool search; a board): the board's graph as Mermaid text on the clipboard; toast "Copied as Mermaid." with what
  was left out (the lossy warnings, and connectors that do not join two shapes). Copy as PNG (a board): the whole board drawn as the
  export draws it, at scale 2, as `image/png` on the clipboard; toast "Copied as PNG.".

---------------------------------------------------------------------------------------------------
## 6e. Plan chart node (src/plan-chart.js)

A view of a plan (§7f) in a draft: docs/plans/gantt-kanban.md §3.5, §7 (roadmap A3; the Gantt view A4).
- Node `planChart` (block, atom, selectable, not draggable), registered after Canvas. Attrs (all `rendered: false`, stored in
  `data-json`): `id` (7-char base36, new on insert), `planId`, `view` ('kanban' | 'backlog' | 'gantt'), `options` (the
  plan's Options object; a missing key is its default: title, columns, labels, priority, hideDone, doneWithinDays, search,
  showDrafts, unpushedOnly, fields, legend, footer, and the Gantt keys), `frozen` (null | `{at, ctx}`: a snapshot of the plan
  context it shows instead of the live plan), `dw` (display width in post px, ≥ 40; null = the content width). Parse
  `div[data-plan-chart]` through `parseChart(json)` (pure: bad JSON → defaults, invalid keys dropped, the snapshot's plan through
  `parsePlan`, unknown view → 'kanban'). Commands `insertPlanChart(attrs)` (after the selection's top-level block, the caret into
  the block after it; one undo step) and `setPlanChart(id, patch)` (merges into the chart with that id; one undo step).
- Data: src/plan-chart.js never imports the app layer. `planSource = {context(planId), subscribe(fn), Chart, open(planId, view)}` is
  filled by src/app/plans.js: the plan context (§7f), a subscription that fires after any plan, draft list or settings change,
  the React renderer (`ChartView`, src/app/components/plan/ChartView.jsx) and opening the plan workspace at the view's tab.
- Drawing (`ChartView`, read-only, inline styles only, in the post colours of §1 for the page theme: `pagePalette`): a title bar
  (`title` null = the view's generic name: Kanban Board, Backlog or Gantt Chart; '' = none); Board: "No status" (while it has cards or `columns` lists it) and the plan's
  columns (`columns` null = all), each ≥ 180 px with 12 px gaps, cards as in the workspace with the chips of `fields` (draft cards
  when `showDrafts`, unless a label or priority filter is set); Backlog: one row per ticket of the tree (children indented),
  columns # · title · status · priority · labels · estimate · start · end · progress · deps · draft · checklist, each but title and
  status shown by its `fields` entry (start / end: `due`; deps: `deps` or `blocked`; draft: `draft` or `pushed`); a parent shows
  its summary dates, estimate and progress; Gantt: the scheduled tickets of the tree (with their parents) as the workspace draws
  them (§7f; the same drawing): a 200 px task list of titles by depth (`showTaskList`), the two header tick rows (`zoom`;
  `weekLabels: 'number'` shows "Wk n" from the plan's week 1), weekend and holiday shading (`showWeekends`; off: an axis of
  working days), the dashed today line (`showToday`), bars, milestones, parent brackets, baselines (`showBaseline`), the critical
  outlines (`showCritical`), conflicts, blocked glyphs and the dependency lines (`showDeps`), over `range` (null: from 2 days before
  the scheduled span to 2 days after it; then, unless `range` sets the end, whole days up to the chart's width, so the grid spans
  the node); a title that does not fit inside its bar goes after it, before it where it would run past the grid's end, cut to
  fit, never outside the grid; then the label legend (labels the shown tickets use, `legend`) and the footer ("n tickets · n done · n d
  estimated · generated as of <date>", `footer`). Filters as the workspace's (labels, priority, hide done, done within n days, the search
  text, unpushed only).
- Readability (also enforced on push): the chart is laid out at `layoutWidth = max(drawn width, its minimum)` (Board: n columns ×
  180 + gaps + 24; Backlog: the shown columns' minimums + 24) and scaled down to the drawn width; a scale below 0.8, more than 200
  cards or more than 80 rows is refused ("Plan chart n: too many columns for the post width — hide columns in Options", …). A
  Gantt is laid out at the drawn width, never scaled (`ganttLayout(…, {exporting: true})`): more than 60 rows are refused ("more
  than 60 rows — filter it in Options"); a zoom whose range does not fit falls back day → week → month → quarter → fit and the
  footer adds "n weeks shown at week zoom" (shown even with the footer off); a range that does not fit at 1 px a day is refused
  ("the date range is too long for the post width — shorten it in Options"). The editor shows a refused chart (a refused Gantt
  laid out with the Plans page's filling, `{fill}`, so it still spans the node) with a dashed
  "Refused on push: …" pill (never exported) and Options… repeats it.
- NodeView: `div.pc` (`width: min(dw px, 100%)`, or 100 %), the chart in a React root, scaled when its layout is wider; a live
  chart redraws on plan changes, a frozen one draws its snapshot; a missing plan shows "Plan not found. Pick a plan or delete
  this chart." (dashed). Click selects (node selection, focus in the editor), double-click or Enter opens the plan at the chart's
  view; unselected: the pointer (hand) cursor and the §6b hover hint "Click to select. Double-click to open the plan." ("Click to select." when the plan no longer exists); selected: 2 px accent outline and an 8 px east-edge handle that drags `dw` (40 … the content width; live, one commit).
  Paste and drop pass through (as a canvas).
- Chart bar (`components/board/PlanChartBar.jsx`, one in App, at the node-selected chart only (never on hover), never over its content: above
  its top edge, right-aligned, 8 px clear; below its bottom edge when the editor viewport has no room above; at the viewport's top
  only for a chart taller than the viewport; inside the viewport horizontally, wrapping when the viewport is narrower): Board | Backlog | Gantt · Options… (a popover styled as
  the board tool options: the translucent island surface (`bg-card/70`, 2 px backdrop blur, island corners), 24rem wide, rows of a
  short muted label (its tooltip says what the row means) and small toggles that wrap; on open the panel itself has the focus (no control focused, so no focus ring or tooltip; keys stay out
  of the document; Tab goes into it). Rows: Title
  (title bar icon toggle + the title box), Columns (Board: a chip per column with its colour dot), Labels (a chip per label: only
  tickets with a ticked label; none ticked: no filter), Priority (icon toggles No priority, Urgent, High, Medium, Low with tooltips;
  none ticked: no filter), Tickets (filter text box, Hide done, Drafts and Unpushed only (not Gantt), Done within [n] days), Fields /
  Columns (Board card fields / Backlog columns: one icon toggle per field with its name as tooltip), Gantt: Range (start and end date
  boxes, Whole plan: an icon button that clears the range), Zoom (compact select, Week no., an info tooltip with the push limits), Show (Deps, Critical, Baseline, Today,
  Weekends, Task list), then Chart (Legend, Footer). A refused chart's "Push refuses this chart: …" line sits on top. About 190–260
  px tall, so it fits above or below the bar; Radix opens it on the side with room) · plan select (another plan: live again) · Live / Frozen
  toggle (Freeze stores the snapshot: the plan without descriptions, links, checklist texts, baselines (a Gantt chart keeps them)
  and ticket stamps, the thread's drafts as id, title and pushed time with their tags, the global tags, today; frozen: its time and
  Refresh, which freezes again) · `width × height` · Full width (`dw` null) · Open plan · Delete. Every change is one undo step;
  buttons never take the focus.
- Insert (§7 toolbar Plan chart, the quick tools, the tool search's "Insert plan chart", the plan header's Insert into draft):
  the plan of the open draft's thread as a live Board chart; without one the plan picker titled "Insert plan chart" (Insert per
  plan; "Create a plan for this thread" when the draft has a thread). The plan header inserts what its tab shows (§7f).
- Export: §5 (`plan-<n>.png` at the drawn width). Smoke: `samples/plan.js` adds a frozen Board chart (four tickets over the three
  seeded columns and a custom column that follows no tag, a draft card, a blocked ticket, an estimate in a custom unit; `dw` 900)
  and a frozen Gantt chart of the docs/plans/gantt-kanban.md §3.7 fixture (critical path A → C → D → M and baselines shown; `dw`
  960).

---------------------------------------------------------------------------------------------------
## 6f. Flowchart library and synced canvases (src/flow/library.mjs, src/app/flows.js)

A library of flowcharts per forum thread (docs/plans/flowchart.md §3.8–§3.9, §5.1, §5.10–§5.11; roadmap B4, closed by C1). A
library flowchart goes into a draft as a synced canvas (a live view of the record; the default) or as a copy (a plain canvas).
- Record (`flowcharts/<id>.json`, §3; `api.flows.*`, §4): `{version: 1, id, threadUrl | null, title, rev, board, source, created,
  updated}`. `title` ≤ 120 chars, default "Flowchart <n>" (n = the thread's flowcharts + 1); `rev` an integer ≥ 1, +1 on every
  board write (Rename and Move to thread keep it); `board` = `{w, h, frame, bg, items}` with the canvas node's attr names (§6b);
  `source` null or `{format: 'mermaid', text}` (at most 1 MB; the Mermaid text an import filled it with, §6d Formats). `parseFlow(json)` (library.mjs, pure, Node-tested in `test/flow-library.test.mjs`)
  never throws: null for a non-object or a non-uuid `id`; the board by the canvas rules (`parseFlowBoard`: items through
  `parseBoard`, no nested canvas, a bad frame → null) except that bad sizes become 1200 × 675; a bad `rev` → 1, a non-string title
  → "Flowchart", a `threadUrl` that is not a forum topic URL → null, `version` missing → 1, an invalid `source` → null (`validSource`). `summaryOf(record)` → `{id, threadUrl,
  title, created, updated, rev, items}` (the list).
- Thread: a new flowchart goes to the open draft's thread, else the selected thread, else "No thread" (`threadUrl` null). Giving
  the draft a thread later moves no flowchart; Move to thread does. A synced node stores neither thread nor title: the record owns
  both.
- Store (`src/app/flows.js`): the summaries from `api.flows.list()` at startup (after the drafts list); records loaded on first
  use (`loadFlow(id)`, calls in flight shared); an id whose load finds nothing is missing for the session. Every board write bumps
  `rev`, replaces the board, joins the record's sync chain (in memory: `rev → {pred, origin, as?}`; origin = the writing draft's
  id, 'library' or 'agent'; `as` = the state a restoring write counts as), redraws the views and is written coalesced (300 ms per
  record, one promise chain). `flushFlows()` runs wherever the board edit is committed (Ctrl+S, push, the workspace switches) and
  in `openDraft`; closing the window waits for pending writes. A failed write toasts "Could not save the flowchart: …"; the next
  change writes again. src/canvas.js and src/export.js reach the store through `flowSource` (canvas.js: `get, load, save,
  isMissing, title, chain, origin, open`, filled by `initFlows`, plus `subscribe` / `changed`), never importing the app layer.
- Synced canvas: the canvas node (§6b) has the attr `flow: null | {id, rev}` (`validFlow`: `id` a uuid, `rev` an integer ≥ 1,
  else null; checked on HTML parse and wherever it is read, since drafts load as JSON). The node's `w h frame bg items` are its
  cache: a synced node is a plain canvas plus `flow`, so a draft stays self-contained, and `flow.rev` names the library state its
  cache was written with. A copy is the same attrs without `flow`. Canvas items on whiteboards are never synced (§6b).
- Live view: the NodeView draws the loaded record's board, else its cache (missing, or not loaded yet; loading starts on first
  sight); its aspect ratio and the canvas bar's size label follow the live `w / h`, `dw` stays per node (two placements may show
  one flowchart at different widths). A change of the record (a write from anywhere, its arrival, a rename, its removal) redraws
  every view of it, and an open in-place editor follows.
- Library edits never write drafts: only views update, so a draft's saved undo history (§7e) stays valid and nothing is marked
  dirty. The cache catches up on the node's own next commit and on insert, Unlink and the delete conversion; meanwhile the cache
  on disk lags, the view and the export do not.
- In-place editing of a synced canvas (§6b, the same session, rail and keys) writes through (`commitSynced`): the library write
  first (origin: the open draft), then the node with the new `rev` and the written board as its cache, as one undo step. A cache
  that lagged the library is first brought up to date in an undo step of its own, so undoing the edit restores the state it was
  made on. While the record is missing only the cache changes (the node keeps `flow`, so a restored file links back).
- Draft undo / redo: when a node's `flow.rev` goes from x to y without its own commit, its restored cache is written back to the
  library (a new rev that counts as state y) only while the library is at state x and every write between x and y came from this
  draft (`writeBackOk`, Node-tested; undoing a catch-up step writes nothing while another canvas of the draft still holds that
  state); otherwise nothing is written and the view keeps showing the live library. The chain is in memory: after a relaunch an
  undo reverts only the cache. New edits: last writer wins (one renderer, one instance).
- Unlink (canvas bar; tool search "Unlink from library"): one step; the node takes the board it shows as its own attrs and
  `flow: null` (undo links it again). Save to library… (canvas bar of a canvas without `flow`; tool search "Save to library"): the
  `saveFlow` dialog asks the title (default "Flowchart <n>"; "The canvas becomes a synced view of the new library flowchart."),
  then a record of the canvas's board is created in the draft's thread and the node gets `flow: {id, rev: 1}` (one step).
- Delete (list row, editor ⋯): AlertDialog `Delete "<title>"?`, "Used in this draft (n places) and n other drafts: here the
  canvases become independent copies; elsewhere they keep their last picture and show "missing". The file is moved to the
  flowcharts trash folder." ("It is not used in any draft." when so; other drafts are read with `api.drafts.load`). Confirmed: the
  open draft's synced canvases of it become copies in one transaction (undo shows them missing) and the file goes to the trash;
  other drafts' files are not rewritten.
- Missing record: the view draws its cache with the missing badge; Open in library is disabled (tooltip "Flowchart missing from
  the library · unlinked view"); Unlink works; the in-place editor works on the cache.
- Badge (editor DOM only, never exported): a pill `.sc-flow` at the top-left inside a synced canvas, the Workflow glyph and the
  live title, muted; missing: `.sc-flow-missing`, dashed amber, "missing". Hidden with the preview while the canvas is edited.
- Canvas bar (§6b) additions: synced: Open in library (`openFlows(id)`) and Unlink; not synced: Save to library…. The edit bar
  starts with the Workflow glyph, the title and "· synced" ("· missing") for a synced canvas.
- Insert flowchart (§7 toolbar Flowchart, the quick tools, Ctrl+Alt+F in the editor, tool search "Insert flowchart"; from the
  library's Insert into draft… only the mode is asked): dialog "Insert flowchart" (`insertFlow` in `FLOW_FORMS`): a searchable
  list (New flowchart, then "This thread": the draft's thread's flowcharts, then "No thread"), a Synced (default) | Copy toggle
  with its help ("A live view of the library flowchart. Edits here change it everywhere it is inserted." / "An independent
  canvas; the library is not changed."), Insert. Synced: the record's board plus `flow`, `dw = min(w, content width)`; Copy: the
  board alone; New + Synced: a new 1200 × 675 record of the draft's thread, synced; New + Copy: an empty 1200 × 675 canvas. From a
  workspace it goes back to the editor first. The canvas goes after the selection's block (as Canvas) and is edited in place with
  the flowchart preset (§6d); a new one starts with the shape tool.
- Library workspace (the Flowcharts tab, §7g; `view = {type: 'flows', flowId}`; tool search "Flowchart library", "New
  flowchart"). Header (`h-9`: 29 px at the 13 px root, §7b; `text-xs`, buttons never take the focus): sidebar button · "Flowcharts" (back to the list) › the
  title (double-click renames it in place) · in the list: thread scope select (the sidebar's threads, No thread, All flowcharts;
  default the open draft's thread, else the selected one) and the filter input ("Filter… ( / )") · Grid | List switch (list;
  icon toggles, tooltips "Grid" / "List"; `settings.flowView` 'grid' | 'list', default grid, kept across restarts) · New
  flowchart (list) · in the editor: W / H, Fit to content, Insert into draft…, Undo / Redo (the record's stack), ⋯ (Duplicate, Move to thread ▸ No thread
  and the sidebar's threads, Delete…) · Back to editor.
- List (`FlowLibrary.jsx`): the flowcharts in scope that match the filter, newest `updated` first, as a grid of cards (default,
  the page's full width from the top left, `p-3`) or as rows (a centred `max-w-3xl` column with `p-3`). Rows: Workflow icon, title, a "used here ×k" badge (its synced canvases
  in the open draft), "n items". Grid: `repeat(auto-fill, minmax(14rem, 1fr))`, `gap-3` (as many columns of at least 14rem
  as the width holds, filled left to right, then top to bottom); a card (`rounded-md border bg-card shadow-xs`, hover `border-ring/60`) holds a 16:9 preview, the title and the meta
  "used here ×k" and "n items" side by side (muted, no separator). Preview: the record's board through the export rasterizer (`rasterizeWhiteboard`, the whole
  w × h artboard, at most 480 px on its long side, on its own bg in the page theme), fitted (`object-contain`) in the area on that
  bg; rendered once the card is on screen (IntersectionObserver; the record loads then), one at a time, cached in memory per
  flowchart keyed by rev and theme (a new key renders again and frees the old picture); an empty flowchart shows a muted
  "Empty", a pending one the muted area. Both views: hover (or focus) actions Insert into draft…, Rename (in place), Duplicate (a
  new record "<title> (copy)"; canvases keep pointing at the original), Delete… (on a card at its top right, over the preview); a
  click or Enter opens it; arrows, Home and End move the selection, which is the focused card or row (Up / Down by one row of
  cards; in rows by one), marked `ring-1 ring-primary` on a card and the accent background on a row; Enter on the page opens the
  selected one; Tab reaches the selected one, else the first; back from the editor, the flowchart that was open stays selected. Empty: "No flowcharts for this thread. New flowchart, or Insert flowchart in the editor." ("No flowchart
  matches the filter.").
- Editor: one fixed Board on the record's board (`unit: 1`) in `#flow-area` (middle-drag pan, Ctrl + wheel zoom 10–400 % around
  the pointer, `src/app/panzoom.js`), opened fitted to the area's width (at most 1 : 1), centred, 24 px below the top; the §6c rail,
  ribbon, quick tools and tool search serve it. Commits are library writes (origin 'library') on the record's own undo stack (50
  steps, in memory; commits within 500 ms merge); an undo is a new rev that counts as the restored state; a draft write clears the
  stack, an agent write through `flow.*` (§8) is one step of it. Opening a flowchart (and New) applies the flowchart preset (§6d). Artboard growth to the left / top scrolls the
  area by as much, so the content stays put.
- Keys: the §6c keyboard set on the Board (C does nothing: canvases do not nest), Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z on the record's
  stack, `/` the shape panel's search (§6g). Paste (window, capture phase, as in canvas edit mode: `Board.pasteEvent`): a copied
  board item (copied on any board, the library editor or a draft's whiteboard or canvas, either way; sizes converted, §6c Units),
  image files (at the centre of the visible part) or Mermaid text (the Import diagram offer, §6d Formats) go onto the board; a
  text being edited and the inputs paste themselves. On `#workspace-root`: in the list `/` focuses the filter, N makes a new
  flowchart and arrows / Home / End select a card or row (Enter opens it); Escape: the Board's steps (text edit, tool, selection), then the editor goes back to the list (in the list it does
  nothing, §7g); an Escape in an input ends that input's edit only. Ctrl+S, Ctrl+Space, Ctrl+Tab and the window zoom keys are
  global (§7g). Ctrl+Alt+F does nothing here (Insert into draft… is the way into a draft).
- Gates (§7g): `flow.open` (a flowchart open in the library), `flow.synced` / `flow.unsynced` (the canvas has / lacks `flow`),
  `flow.present` (its record is loaded).
- Export (§5): a synced canvas is rasterized from its record's live board (the record loaded first); a missing record exports
  the cache, so Push never needs the library. The badge never exports.
- Smoke: `samples/flow.js` adds a synced canvas (800 × 300, `dw` 400) whose record does not exist (`flow: {id:
  '00000000-0000-4000-8000-000000000001', rev: 3}`): it draws and exports its cache with the missing badge. `window.__smoke()`
  returns `flows: {missingBadge}` and scrolls that badge to the middle of the editor area for `smoke-ui.png`.
- Agents: the assistant reads and edits the library through `flow.*` (§8 Catalogue, built 2026-10-06), by flowId, also when no
  draft is open; a write to a flowchart shows at once in the library editor (FlowEditor follows `flowSource`) and in every synced
  canvas of it. Not built yet: `flow.link`, `flow.unlink`, `flow.import`, `flow.export`, `flow.undo` / `flow.redo` (roadmap C4).

---------------------------------------------------------------------------------------------------
## 6g. Prefabs and the shape list (src/flow/prefab.mjs, src/app/shape-list.mjs, src/app/prefabs.js)

Roadmap B5 (docs/plans/flowchart.md §3.10, §5.12). A prefab is a named group of board items saved to be placed again. Prefabs
belong to the user (global, no thread) and live in `prefabs/` (§3, §4); `src/app/prefabs.js` lists them the first time a shape list
opens and writes each change at once (a failed write toasts "Could not save the prefab: …" / "Could not delete the prefab: …").

- Create prefab… (board menu, §6c; tool search, §7c): ends a text edit, asks for the name (dialog: default "Prefab n", n = the
  number of prefabs + 1; at most 80 characters; OK = Create), saves the selected items and toasts "Prefab saved". The saved form
  (`makePrefab(items, unit)`, pure): copies with ids local to the prefab; a connector keeps a binding only when both its ends were
  selected (an end on an unselected item becomes free at its tip); the group's bounds (a turned shape by its turned box, a connector
  by its path) moved to 0,0; sizes in post px (§6c Units: stored ÷ the board's unit); connector routes dropped (every renderer
  routes them again). Every item type is kept (canvas items only come from a whiteboard). `w`, `h` = the bounds in post px. The
  thumbnail is a PNG data URL of the items on a transparent background, at most 192 px on its long side (`rasterizeWhiteboard`); a
  prefab without one gets it the first time the list is shown. `parsePrefab` (pure, never throws) runs the items through
  parseBoard (dangling ends repaired), names a nameless one "Prefab", keeps ≤ 10 keywords of ≤ 40 characters, recomputes a bad `w` /
  `h` and keeps `thumb` only as a PNG data URL.
- Placing: a click on a prefab tile arms the shape tool with it (the tile shows pressed, the Shape button shows its thumbnail and
  name, the board snapshot's `prefab` its id). The next click on the board places it as the Placement tools place (§6c): the
  group's top-left at the snapped pointer, kept inside the bounds; sizes × the board's unit (`prefabItems(prefab, unit)`); new ids,
  the copies' connectors bound to the copies; the copies selected; one undo step; the tool returns to Select. Picking a kind,
  another tool or Escape disarms it. Any tile (a kind, a prefab, the panel's connector and text tiles) dragged out of the list
  shows a see-through ghost of what it adds, at the board's on-screen scale, centred on the pointer; released over the board the
  list serves (the library editor: anywhere on its view) it is added with its group centred at the snapped pointer, selected, the
  tool back to Select, one undo step (§6c Spawning); released elsewhere nothing happens. On a canvas, canvas items are left out
  ("Canvases cannot go inside a canvas" when nothing is left).
  A placed prefab is an independent copy: renaming or deleting the prefab changes no board.
- Shape list (the §6d popover): sections Favourites (hidden while empty), Basic, Flowchart, Containers, Prefabs. Prefabs show in
  the shape tool's list only (its flyout, the quick tools island, the tool search options); the ribbon's list, which changes a
  selected shape's kind, shows kinds only (Favourites without prefabs). A starred entry shows only in Favourites. A prefab tile is
  three columns wide: its thumbnail on the post background, the name under it. Prefabs without any prefab: "Select items,
  right-click, Create prefab…". The search matches prefab names and keywords as well; while it has text the sections give way to
  one Results section, best match first (ranked as the tool search ranks). The list scrolls past 30rem.
- Shape panel (the library editor, §6f; draw.io-like): the same list (one implementation, `ShapeList` in
  `components/board/controls.jsx`) docked on the left of the board, after room for the §6c rail: a card-coloured column with a
  "Shapes" header and a Hide button (collapsed: a narrow strip with Show), its search on top ("Search shapes… ( / )"; `/` anywhere
  in the editor, not typing, opens the panel and focuses it), then collapsible sections Favourites, Prefabs, Basic, Flowchart,
  Containers, Connectors (Elbow, Straight, Curved, Dashed, Two-way arrow, Line) and Text & notes (Text, the four note colours);
  tiles in a dense grid as wide as the panel, each with its name as tooltip. Its right edge drags its width (200–360 px, default
  240); width, collapsed state and closed sections are kept in localStorage (`daf-writer.shapePanel`). A tile's click arms the
  tool (a kind or prefab: the shape tool; a connector style: the connector tool in that style; text / a note: Text with that
  note colour) and hands the focus to the board, so the next click places it (Placement tools, §6c); the armed tile shows
  pressed. A drag places it where released (above); a double-click adds it at the centre of the visible board. Keys: arrows move
  between tiles, Enter arms, Escape returns to the board. Prefabs doubles as a scratchpad: board items dragged onto it (a move
  released over it) go back where they were and Create prefab… asks for the name (the board's own auto-scroll pauses over it).
  Connector and text tiles have no star, entry menu or order.
- Favourites: a star button at each tile's top-right corner (shown on hover and focus, filled when starred) toggles it; a starred
  entry goes to the end of Favourites, an unstarred one back to its section at its saved place.
- Order: each section keeps the user's order (`settings.shapeOrder`, written once that section is reordered; Favourites:
  `settings.shapeFavourites`). Entries missing from a saved order come first (a new prefab shows at the top of Prefabs, whose
  default order is newest first). A tile dragged with the pointer (after 4 px; an insertion bar shows) onto another tile of its
  section goes before or after it, by the half; onto Favourites (shown as a drop target during a drag) it is starred at that place;
  a favourite dropped on another section is unstarred. Alt+← / → (also ↑ / ↓) move the focused tile one place within its section,
  and releasing Alt then does not open the window menu. A section header shows Reset order (RotateCcw) while its order is the
  user's: a section with a saved order, or Favourites out of their default order (registry order, then prefabs by `created`). Each
  change is one settings write; refs to deleted prefabs and unknown kinds are dropped at the next write (`cleanRefs`) and skipped
  until then.
- Entry menu (right-click a tile, or Shift+F10 / the context-menu key on a focused tile: the board menu's pointer-anchored dropdown,
  under the tile for keys): Add to / Remove from favourites · Move earlier (Alt+←) · Move later (Alt+→); a prefab also Rename… (the
  name dialog, OK = Rename) · Duplicate ("<name> (copy)") · Delete… (asks 'Delete prefab "<name>"?' with 'Items already placed
  stay.'; the file goes to `prefabs/.trash/`). Closing it returns the focus to the tile.

---------------------------------------------------------------------------------------------------
## 7. UI (index.html, src/app/, src/page.css; built as §7b says)

index.html: CSP `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'">`,
`<html class="dark">`, links `dist/app.css`, `<div id="root">`, loads `dist/renderer.js` at end of body. `document.documentElement.dataset.theme` = settings.theme.

Layout: CSS grid — sidebar 290 px (collapsible, see below) | main (scrollable editor area `#editor-area` with the §6c tool
rail floating at its left edge and the toolbar's formatting controls as a floating island at the bottom centre, close to where
new lines are typed (menus open upward; the area's bottom padding and the editor's scroll margin keep the last lines and the
caret clear of it)) ; status bar bottom (full width). Above both, the title strip (full width, 34 px including its 1 px
bottom hairline, `.titlebar` in app.css, `bg-background`): the app icon (`build/icon.svg`, 16 px) and "EasyWriter" (12 px,
muted foreground) at the left, `-webkit-app-region: drag` (controls placed in it, and the menus, selects, popovers, dialogs and palettes
that reach up over it, are no-drag), the right end left to the
native window controls (padding-right from the Window Controls Overlay's `env(titlebar-area-*)`; §4). It is chrome, so always
dark like the sidebar and status bar; everything below it is shifted down by its height only (the viewport math reads element
rects, so it follows).
Sidebar collapse: a small floating icon button at the bottom-left corner of the editor area (lucide PanelLeftClose /
PanelLeftOpen, Tooltip "Hide sidebar (Ctrl+\)" / "Show sidebar (Ctrl+\)") hides or shows the whole sidebar; Ctrl+\ does the
same. The state persists (`settings.sidebarCollapsed`). The editor area takes the freed width at once: page zoom Fit, the
toolbar island's centring and the canvas previews follow (no window resize needed). The button never overlaps the rail or the
toolbar island; it is the only sidebar control while the sidebar is hidden. Toasts appear at the top right, 24 px below the title strip (clear of the window controls). The §6c item ribbon is fixed-positioned at the selected board item.
App chrome is always dark (shadcn/ui neutral palette, §7b), independent of the page preview theme.

Sidebar:
- Account: one row: "Logged in as <name>" / "Not logged in" (one line; a long name ends in "…", full text in a tooltip), then
  icon-only buttons with Tooltips, in fixed slots so nothing shifts when the login state changes: `Log in` (logged out) /
  `Forum window` (logged in) in the same slot, `Find my threads` (discover → merge into settings.threads by topic id, `mergeThreads` in thread-url.mjs: a listed topic keeps its stored URL, so its drafts and plan still match after a slug change), Settings.
- Post section (between Account and Threads): the open draft's post actions on one line: the thread select (takes the free
  width, long labels end in "…"), then icon-only Save and Push to forum (primary; Unpush, outline, when the draft is pushed),
  same size, with Tooltips, so nothing shifts.
- Threads grouped by year then subject: subject bold, topic title small. Click = select (settings.selectedThread; filters drafts; shows the editor page, §7g).
  Per thread: "Plan board" (SquareKanban: the thread's plan, created after a confirm, §7f), "Open in forum" and remove (×,
  confirmDialog); a thread that has a plan shows its open-ticket count (tickets not in the done column) before them. Removing a
  thread keeps its plan (the plan picker lists it under "Without a thread"). `+ Add thread URL` → modal input; any common form of a topic link (http or https, www. or no scheme, a page number, query or
  hash) is stored as one canonical URL `https://daf.staffs.ac.uk/topic/<id>-<slug>/` (`src/thread-url.mjs`, Node-tested); a topic already
  listed in any form is refused. The row shows at once with a title from the slug ("12345-level-design" → "Level design"; no slug →
  "Topic 12345"), then `api.forum.describe` fills subject, year and forum, and the title unless the user gave one; an unreadable page
  leaves the slug title. `threads.add` (§8) does the same. After a status check or a login that finds the user logged in, up to 50
  listed threads without year and subject are described in one batch (threads added before this existed).
  "All drafts" entry at top.
- Drafts for the selected thread: tag dot, title (as much as fits: no time label, ellipsis only at the row end), a green
  circle tick (CircleCheck, tooltip "Pushed to the forum") when pushed. Row hover actions (Tag, Move to…, Delete) are laid over
  the row's right end on hover instead of reserving space. `+ New draft` (threadUrl = selected thread). A click on a row opens
  the draft, and a row or New draft shows the editor page from Plans / Flowcharts (§7g); the open draft's row is highlighted
  only on the editor page.
  Delete (confirmDialog; moves to trash).
- Draft status tags (local only, never pushed to the forum). Each draft has at most one tag, which is its work status; this is
  the field a later Kanban board (columns = tags, in tag order) and Gantt chart will use, so it lives in one small module
  (`src/app/drafts-meta.js`: tag definitions, defaults, lookups, assignment; pure functions + unit tests) that the sidebar uses
  and later views can reuse.
  - Definitions: `settings.tags = [{id, name, color}]` in display / workflow order. Defaults when the key is missing:
    To do `#e5e5e5` (white), In progress `#3d99f5` (blue), Done `#62d926` (green).
  - Assignment: `settings.draftTags = {<draftId>: <tagId>}` (stored in settings like folders, so tagging never rewrites a draft
    file or its `updated` time; entries for deleted drafts or tags are dropped the next time the map is saved).
  - Draft row: a small dot in the tag's colour at the left of the title (an empty, dimmed ring when untagged), in a fixed slot so
    titles line up; tooltip = tag name. Clicking the dot, or a "Tag" hover action, opens a DropdownMenu: each tag (colour dot +
    name, the current one checked), then "No tag". Hover actions keep their space (no layout shift).
  - Settings dialog: a "Tags" section like the preset manager: rows of name + colour (native colour input as a swatch) + delete,
    drag or up / down to reorder, "Add tag". Deleting a tag that is in use asks through confirmDialog and untags those drafts.
- Draft folders (grouping in the Drafts list). Stored in settings only, so moving a draft never rewrites the draft file or its
  `updated` time: `settings.folders = [{id, name, open}]` (display order; a new folder goes last) and
  `settings.draftFolders = {<draftId>: <folderId>}`. Missing keys mean no folders. Entries that point at a deleted draft or folder
  are ignored and dropped the next time the map is saved. Folders are global (not per thread).
  - Header: a "New folder" icon button next to `+ New draft` creates a folder named "New folder" and starts renaming it at once.
  - Folder row (same compact row height as a draft): chevron, folder icon, name (ellipsis), count of the drafts it shows; hover
    action Delete. Deleting a folder that holds drafts asks through confirmDialog and moves those drafts back to the top level;
    drafts are never deleted with a folder.
  - One click on the row opens or closes the folder (`open` persists). A double-click on the name renames it inline (Input, text
    selected; Enter or blur saves the trimmed name, an empty name or Escape cancels). The two clicks of that double-click leave
    the open / closed state as it was.
  - Folders are listed first, then the drafts that are in no folder. Drafts inside an open folder are indented and follow the manual order below. With a thread selected a folder is shown when it is empty or holds at least one draft of
    that thread, and it lists only those drafts.
  - Manual order: drafts are listed in the user's order, never by time. `settings.draftOrder = [draftId, …]` holds it (one
    list for all drafts; the top level and each folder show their drafts in that relative order). A draft that is not in the
    list yet is placed first, so new drafts appear at the top; the first time, existing drafts keep their `updated`-descending
    order. Reordering never touches a draft file.
  - Dragging a draft row (after 4 px of movement, so a click still opens it) shows an insertion line between rows; dropping
    there moves the draft to that position, at the top level or inside an open folder (it joins that folder). With a thread
    selected the draft is placed relative to its visible neighbours. Folder rows are dragged the same way to reorder the
    folders (`settings.folders` order).
  - Moving: drag a draft row onto a folder row (the folder highlights while a draft is over it and opens on drop) or onto the
    "Drafts" header / top-level list to take it out; and a "Move to…" hover action on every draft row (DropdownMenu: each folder,
    then "Top level"; the current place is checked). A new draft starts at the top level.

Toolbar (one row at the default window size, wrapping between control groups on a narrower window; buttons show active state, updated on `transaction`/`selectionUpdate`):
Undo, Redo | Block style select (Paragraph, Heading 1–6) | Font select (Default + FONTS) | Size select (FONT_SIZES %) |
Bold, Italic, Underline, Strike | Sub, Sup, Inline code | Text colour dropdown (swatches of TEXT_COLORS) |
Highlight dropdown (None + HIGHLIGHTS) | Align L/C/R/J | Bullet list, Ordered list | Quote, Code block, Horizontal rule |
Table insert (3×3 header row) + when in table: add row after, add column after, delete row, delete column, delete table |
Box | Link (modal URL input; empty = unset) | Whiteboard | Canvas (insert a smart canvas and edit it in place) | Flowchart (lucide
Workflow, "Insert flowchart (Ctrl+Alt+F)") | Plan chart (SquareKanban, "Insert plan chart") | Image (file picker → addImageFilesToEditor) |
Presets dropdown (apply; last entry "Manage presets…") | Clear formatting.
Flowchart and Plan chart are also in the quick tools' insert group (§7d). Plan chart inserts a plan chart (§6e). Flowchart opens
the Insert flowchart dialog (library flowchart or new, synced or copy; §6f). Undo / Redo disabled, the
table operations and the two insert buttons read the gates of `src/app/gates.mjs` (§7g).
Post actions (in the sidebar's Post card, not the toolbar): thread select for current draft (sets draft.threadUrl), Save, Push to forum (primary button). When the open draft is pushed, that button reads "Unpush" instead and clears pushedAt after a confirm.
Buttons are lucide icons with Tooltips (§7b); no icon fonts, no external resources.

NO `window.prompt` / `confirm()` / `alert()`. Form dialogs (link, add thread, choose thread, settings) are React Dialogs opened
with `openDialog(type, props)` in actions.js, which resolves with the result or null on Cancel / Escape; confirmations and
messages use `confirmDialog` (AlertDialog, §7b) or toasts.

Import diagram dialog (`importDiagram` in components/flows/forms.jsx; roadmap C3; what the import does: §6d Formats): title "Import
diagram"; a monospace textarea (focused; an example as its placeholder; prefilled by a Mermaid paste onto a board); below it the
parser's first error as "Line L, column C: message", else a one-line hint; a preview of the laid-out diagram drawn by the canvas
preview, fitted and centred on the post background, redrawn 150 ms after typing stops; the warnings (unknown shapes, skipped
statements) with their lines; a direction select (As in the text, Top to bottom, Left to right, Bottom to top, Right to left, each
with its icon) and, when the import goes onto a board, the checkbox "Replace board contents" (off: the diagram is added). Import
(OK) is refused with the error while the text is empty or does not parse; Cancel / Escape changes nothing.

Page preview: `.page` box with background post bg, padding 22 px, content width exactly `settings.forumWidth` px; forum typography from §1
scoped under `.page .ProseMirror` (both themes via `[data-theme]`). `.page` font-family = baseFont (fallback system stack),
`.ProseMirror` font-size = 16px; only paragraph text scales by baseSize/100 (matches `applyBaseStyles`: headings, code and sized text are not scaled).
Mark CSS: `[data-ips-font-size="N"] {font-size: N%}`, `[data-i-color="K"] {color: …}`, `mark[data-i-background-color="K"] {background: …}`,
Box styling (title bar bold, bordered panel). Zoom control (status bar, right; `state.zoom` is 'fit' or a percent number, 78 at startup): a slider (25…200 %, step 1, applies live while
dragged), then the current percent as a number (while Fit is active: the computed percent, rounded); clicking the number turns it
into an input (text selected) for an exact value: Enter or blur applies it (integer, clamped to 10…400), Escape cancels. Last, a
presets button that opens its whole list upward on click (Fit, 50, 67, 75, 90, 100, 125, 150 %; the active one checked; no scroll
arrows and nothing that reacts to hover); the button reads "Fit" while Fit is active. Fit = min(1, available / (forumWidth+44)); The editor area is a canvas-like view: the page sits on an unzoomed pan surface
of one view size minus 120 px on every side, so it can be moved anywhere (not locked to the centre) but at least 120 px of
it always stays in view. Wheel scrolls, middle-button drag pans in both axes (grabbing cursor), Ctrl + wheel zooms (about 10 % per wheel notch, proportionally finer for touchpad deltas, 10…400 %) around the pointer; the slider, typed value and presets zoom around the centre of the view. All of
this also applies while a canvas is edited in place (§6b): it moves and zooms with the page. Home view (on opening a draft and when Fit is chosen): page centred
between the rail (56 px) and the right edge (24 px), its top 24 px below the top of the view. The horizontal scrollbar is
hidden; the vertical one stays.
apply with CSS `zoom` on the page wrapper. Recompute on resize.

Background clicks (every canvas-like view; `backgroundClick` in src/app/viewport.js): a primary pointer-down on a view's empty
background, outside its content, clears the selection. Not on a scrollbar; a press that only closes an open popup does only
that (§6c Dismiss-only clicks); middle-drag pan and the chrome over the view (rail, bars, ribbon, islands, toolbar, chat panel,
dialogs) are unaffected, and so is the keyboard.
- Editor: a click in `#editor-area` around the page, or in the page's padding, puts the caret at the nearest text position at the
  click's height (x clamped into the text column, as a word processor's margin): a node-selected block (canvas, whiteboard,
  chart, image) or a cell / text selection gives way to it (beside a block: the caret goes before it from its upper half, after
  it from its lower half), the whiteboards' item selections clear, the editor takes the focus, nothing scrolls. While a canvas is
  edited in place the click leaves Canvas Mode first (§6b; the canvas stays node-selected), so the next one gives the caret.
- Library editor (§6f): a click in `#flow-area` outside the artboard deselects as a click on empty board area does (an open text
  edit ends; the board keeps the focus).
- Plans (§7f): Board, the strip between and around the columns and a column's empty space; Backlog, the space around and below
  the rows; Gantt, the space below the rows (the chart's own empty space already clears).

Behaviour:
- Startup: load settings, apply theme, status(), threads, drafts; open `lastDraftId` or newest draft or a new one.
- Autosave: debounce 800 ms after each doc change → `drafts.save({…draft, title: draftTitle(doc), doc})`; flush before switching drafts
  and on `beforeunload`. Status bar: "Saved 14:03" / "Saving…" / "Unsaved", word count, login status, then the agents slot (§8): empty while
  `state.agent.connections` is empty; "Agent: <name>" (two or more: "Agents: N"), a ghost button that opens a Popover above it
  listing each connection (name, "since HH:MM", and Disconnect, which calls that connection's `disconnect()`; disabled when it has
  none); `onCloseAutoFocus` refocuses the editor. A toast "<name> connected" / "<name> disconnected" follows the `agent.connected`
  / `agent.disconnected` events (`on` of commands.js).
- Shortcuts: Ctrl+S save now; Alt+1…9 apply preset N; Ctrl+Alt+W insert whiteboard; Ctrl+Alt+C insert smart canvas (and edit it in place); Ctrl+K link.
  Window zoom: Ctrl+= (or Ctrl+Plus, numpad +) zooms in, Ctrl+- out, Ctrl+0 resets (`api.window.zoom`; the main window has
  no menu), also while a canvas is edited (§6b, which turns the document shortcuts off meanwhile).
- Settings dialog (gear button in sidebar): forum width (number, reset to 1454), theme (dark/light), base font (Default + FONTS),
  base size (FONT_SIZES), undo history (§7e), presets manager (rows: name, font, size, colour, highlight, B/I/U checkboxes, delete; add row),
  then the Tags, Dictation (§7h), Assistant and Local AI agents (§7i) sections. Save → settings.set → re-render.
  Layout: a section nav column on the left (11rem: one ghost button per section, lucide icon + short name: General, Presets,
  Tags, Dictation, Assistant, AI agents) and on the right one continuous scrolling column of all sections (not tabs). A nav
  click scrolls the column so the section's heading lands just below its top (smooth; instant under reduced motion); while the
  column scrolls, the entry of the section at its top is highlighted (`aria-current`), the last one once the end is reached
  (the last section is at least the column's height, so every heading can reach the top). Only the column scrolls; the nav,
  title and Save / Cancel stay put. Each section is a heading (`h3`, `text-sm` semibold) with its hint as a muted `text-xs`
  line, sections separated by a hairline and `py-6`; fields are an `8rem` label column with `gap-x-3 gap-y-2`. The dialog
  uses the shadcn Dialog spacing (`p-6`, `gap-4`, `rounded-lg`; an exception to the §7b panel padding), is 68rem wide at most
  (window width minus 2rem) and has a fixed height of min(60rem, window height − 34 px − 2rem), centred in the room below the
  title strip. It opens with the forum width field focused and selected, as before.
- Push: needs draft.threadUrl (else modal to choose a thread). `confirmDialog` titled 'Fill the reply box of "<subject — title>" with this draft?',
  description 'You review and press Submit in the forum window.', button "Push".
  Overlay "Rendering whiteboards…" then "Uploading images in the forum window…". `buildPayload(editor, settings)` → `api.forum.push({threadUrl, ...payload})`.
  ok → set `pushedAt`, save, toast "Content placed in the forum reply box. Review it there and press Submit." Error → AlertDialog "Push failed" with the message.
- Toasts: small bottom-right messages, auto-hide 5 s.
- `window.__smoke = async () => {...}`: set editor content to a sample doc covering: h1 centred, h2, paragraph with bold/italic/
  underline/strike/fontSize 150/textColor blue/highlight yellow/fontFamily Georgia/link, bullet + ordered list, quote, code block,
  table 2×2 with header, box, and a whiteboard (height 300) containing one image item (a 400×200 canvas-generated PNG data URL with a gradient
  and the text "WB") and one text item, and a smart canvas (600 × 300, dw 300) with one shape item. Wait 2 animation frames + 300 ms, then return `{...await buildPayload(editor, settings), text: editor.getText().slice(0,200)}`.

---------------------------------------------------------------------------------------------------
## 7c. Tool search (Ctrl+Space)

A command palette for the editor tools: type plain English, pick a tool.

Registry (one module, `src/app/tools.js`): every control of the toolbar and of the §6c rail is one entry
`{id, label, icon, group, keywords: [...], needs?, also?(ctx), run?(ctx), command?, args?(ctx), options?, shortcut?, toggle?, notice?,
category?, risk?, headless?}` (an entry without `run` or `command`, e.g. Text colour,
Font, Snapping, Background, only has options). `run` and the enabled / active state reuse the
existing commands (the toolbar's `textTools`, Board methods, actions.js); no logic is duplicated. `when(ctx)` limits an entry
to where it applies: text mode (caret in the document), board mode (a board is active, §6c), a whiteboard only, a
board selection (Duplicate, Delete, Front / Back: any selected items; Reset size, Reset crop, Edit canvas: a single item), or a
node-selected block (Palette: Selected block). The formatting entries (group Text, Clear formatting, Manage presets, the font
presets) also need a caret or text selection (gate `node.none`); the Insert entries do not. Entries that do not apply are not
listed. `when(ctx)` is derived: the entry's `needs` (gate ids of `src/app/gates.mjs`, or `{gate, with?}`) plus its command's
`needs`, read on the tool context (ui = the editor and the view, board = the served board's snapshot, doc = `{inTable}`, history =
the board's snapshot or the editor's undo state, draft = the open draft, node = the node-selected block `{type, attrs, kind, view}`,
flow = the library record a node-selected synced canvas shows), and `also(ctx)` for what no gate expresses (text entries:
the search serves the document, not a board; Reset crop: the image is cropped; App entries: the draft is saved, folders exist). The
plan and flowchart entries keep their own `when`. `risk` (default write; Delete board, Delete (items or a selected block) and Delete table are
destructive, Push to forum is approval) and `headless` (default true; Add image, Insert image, Link, Manage presets and Settings
are false: a picker or a dialog) are what `tool.run` applies (§8). An entry with `command` runs that command (§8) with `args(ctx)`
as source `palette`, so it is audited; `src/app/commands/palette.mjs` names the command ids the palette uses (`PALETTE`,
`PALETTE_COMMANDS`; the contract test checks them against the catalogue). Shape kinds are entries of their own, one per registry kind with its label, keywords and preview ("Arrow", "Circle",
"Database", "Decision", … switch to the shape tool with that shape).
Connectors (`tools-flow.js`, §6d): Connector (A; options: the tool's settings), and for one selected connector Connector
properties (its ribbon controls), Connector labels (the Labels popover's rows), Reverse connector, Straighten connector (only with
bends). Arrangement (`tools-flow.js`, §6d; group Item): Align left / centre / right / top / middle / bottom, Distribute
horizontally / vertically, Same width / height (two or more selected items), Rotate 90° (R; a selected shape or two or more items;
options: Rotate and the angle field), Copy style (Ctrl+Shift+C; one shape, connector, text or stroke), Paste style (Ctrl+Shift+V;
a selection, once a style is copied). Prefabs (`tools-flow.js`, §6g): Create prefab… (group Item, a selection; the board menu's
entry), Insert prefab (group Board, a board; options only: the shape list, opened at its Prefabs section; a kind picked there turns
the shape tool on with that kind). Diagrams (`tools-flow.js`, §6d Formats; group Flowchart): Import diagram… (text mode: a new
canvas; a board: onto it), Auto layout (a board; options only: the four directions), Copy as Mermaid and Copy as PNG (a board).
Keywords: each entry has the words a user would type for it, synonyms included, e.g. Pen: draw, brush, pencil, freehand,
sketch, ink, marker, highlighter; Eraser: erase, rubber, remove stroke; Text colour: color, font colour, red, blue, …; Heading 2:
h2, title, subheading; Bullet list: unordered, dots, points; Insert canvas: frame, artboard, smart canvas; Undo: back, revert.

Palette:
- Ctrl+Space opens it (also while a canvas is edited, a text item or input has focus); Ctrl+Space, Escape or a click outside
  closes it (on a board that click does nothing else, §6c Dismiss-only clicks). A shadcn Command dialog opened at the mouse pointer
  (the pointer never moved in the window: the centre of the page's viewport, §7g; the §7d quick tools too): its top-left corner a few px right / below the pointer. No room
  below: it opens above the pointer, flipped (search input at the bottom, next to the pointer); no room above either: as low
  as fits. No room to the right: moved left. Always 8 px inside the window; placed once on open (filtering never moves it).
  Search input with placeholder "Search tools…", the
  matching entries below in groups (Board, Text, Insert, Item, Edit, Plan, Flowchart, App), each row: icon, label, its shortcut, and a "Tab: options"
  hint for entries with options. Compact density.
- Filtering is fuzzy over label + keywords and ranks the best match first. The best match is highlighted automatically while
  typing; nothing happens until it is committed. Arrow keys move the highlight; the mouse hover moves it too.
- Enter or a click commits the highlighted entry: the palette closes, focus returns to where it was (the document keeps its
  selection, a board keeps focus), the entry runs (a command entry: `invoke({id: command, args: args(ctx) ?? {}, source:
  'palette'})`, then the focus goes back again, as New draft remounts the editor, and the notice shows the label or the error),
  and a notice appears. An entry that only has options opens its options
  panel instead. Add text / Add canvas switch to that placement tool (§6c; notice "Text: click to place" / "Canvas: click to
  place"); Add image opens the file picker.
- Tab commits the highlighted entry with options: it runs the entry (a mode tool switches to that tool) and instead of the
  notice opens the entry's options panel. On an entry without options Tab does nothing.
- Selection kept: opening the palette changes no selection (the editor's text, node or cell selection, a board's selected
  items). While the editor is not focused (the palette, the chat panel or a menu has the focus) a text selection stays drawn
  (`.inactive-sel`, src/page.css; `InactiveSelection` in src/extensions.js); closing the palette gives the focus back with the
  same selection, without scrolling (an input or the §7i chat box gets its focus back too). On open (`toggleToolSearch`) the
  palette also takes what is selected as an assistant attachment (`state.toolSearch.attach`, `src/app/assistant/capture.js`, §7i
  Attachments) and refreshes the assistant's status.
- Resolve with assistant: a query that no entry matches shows "No tool found."; while the assistant is usable (§7i) it shows one
  highlighted entry instead, "Resolve with assistant" (MessageSquare icon). Enter or a click closes the palette, opens the chat
  panel (whatever its state) and sends the query with the attachment as a pill after it and a note for the model: "The user
  typed this in tool search in the draft editor." (or the Plans page, the Flowcharts page; ", editing a canvas" in Canvas Mode),
  plus "The attachment is what they had selected." when there is one (`assistant.js` `ask`). While a reply runs, the query and
  the pill go into the text box instead, for the user to send.
- With an empty query the list shows the applicable entries in group order (a selected block's sections or flowchart mode's
  first, below).
- Selected block: while the editor view has a block node-selected where its bar would serve it (a smart canvas, a flowchart
  canvas, an image, a plan chart; a whiteboard clicked on its empty area, no item selected; never while a canvas is edited in
  place), the first section is that block's actions under its name: Flowchart canvas, Smart canvas, Image, Plan chart or
  Whiteboard (`blockKind` in `tool-rank.mjs`: a canvas that is a flowchart as in flowchart mode, else a canvas holding one image,
  else a smart canvas). Its main action is first and highlighted with an empty query. Then Suggested: Flowchart library (a
  flowchart or smart canvas), Open plan board (a plan chart), Assistant. Then the other entries in group order; the formatting
  entries are not listed, the Insert entries are. The actions are the bar's and run the bar's code (the same NodeView methods;
  `tools.js`, `tools-plan.js`; order: `BLOCK_SECTIONS`; group Item; gate `node.is` with the kinds):
  - flowchart canvas: Edit (Enter; Canvas Mode), Open in library and Unlink from library (synced; Open in library only while the
    flowchart is in the library) or Save to library (not synced), Actual size, Full width, Delete (Del);
  - smart canvas: Edit, Save to library, Actual size, Full width, Delete; image: Edit, Actual size, Full width, Delete;
  - plan chart: Open plan (Enter; the plan exists), Board / Backlog / Gantt view (the other two), Freeze (live, the plan exists) or
    Refresh and Show live (frozen), Full width (a set width), Delete (Del). Options… and the plan select stay on the bar;
  - whiteboard: Pen, Add text, Shape, Add canvas, Fit height, Background, Delete board (the board entries, moved up).
  While typing, match quality still ranks first; between matches of the same quality the order is the block's section,
  Suggested, the rest (`tool-rank.mjs`).
- Flowchart mode: in the library editor (§7g), and on a canvas edited in place that is a flowchart (synced with the library,
  imported from a diagram, or holding a connector or a flowchart-group shape), the palette favours flowchart work. With an
  empty query its sections are Flowchart shapes (the registry's Flowchart and Container kinds), Text (Add text, Connector
  labels), Basic shapes, then the other entries in group order. While typing, match quality still ranks first; between
  matches of the same quality the order is flowchart shapes, text, basic shapes, the rest (`tool-rank.mjs`). Elsewhere (a
  whiteboard, a plain canvas, the document) the palette is unchanged.
- Plan entries (`src/app/tools-plan.js`): Insert plan chart (group Insert, text mode: the toolbar's button, §6e); group Plan: Open
  plan board (editor view, a selected or draft thread), and in the plan
  workspace (§7f) Board / Backlog / Gantt (the other tabs), New ticket, Undo / Redo plan change (when the plan's stack has one),
  Back to editor. The document's Undo / Redo entries are not listed there.
- App entries (group App, last in the group order): New draft (`drafts.create`: a saved empty draft in the selected thread, opened
  without the page changing; the focus goes to its editor), Save (Ctrl+S's commit and save; a document open), Push to forum (the
  Post card's push; listed only while the open draft has a thread and is not pushed: gates `draft.hasThread`, `draft.unpushed`),
  Settings, and three entries that only have options: Select thread… (a select of All drafts and the threads → `threads.select`),
  Tag draft… (No tag and the tags → `drafts.setTag` on the open draft; a saved draft), Move to folder… (No folder and the folders →
  `drafts.move`; a saved draft, some folder exists). Their choices run the command as source `palette`; a failure shows its message
  as the notice.

Summoned popups (the palette, the options panel, the §7d quick tools, and any later summoned popup) are exclusive: summoning
one closes the one that is open (the palette first gives the focus back as on Escape).

Notices (`src/app/components/Notices.jsx`: `notify({icon, text, mode?})`, store `notices`): the tool search's notice is a small
pill (icon + "Pen", "Bold on", "Heading 2", "Duplicated", …); the Canvas Mode notice (§6b) and the paste notice below share it.
They stack just above the toolbar island, in one bottom column with the §7h transcript pane (`Dictation.jsx` renders the
column; App.jsx passes the stack as its child): the column is centred in the page's viewport (§7g), its bottom 8 px above the
island (no toolbar: the last such offset above the viewport's bottom), and holds, from the bottom up, the transcript pane (while
shown and not minimized) and the stack, 8 px apart, in normal flow (no computed positions). So the stack rests 8 px above the
island, or 8 px above the pane's live top, and follows every change of the pane's height in the same frame: showing, growing
with text, the close sequence and the reverse open (§7h). The column takes no pointer and makes no stacking context: the stack
(z-40) draws over the pane (z-30), and both draw over the §7i chat panel (z-20). Each notice is translucent (pill: card at 70 %, 2 px backdrop blur; mode notice: a slightly larger pill, card
at 40 %), pointer-events none (it never takes focus or a click), shown at once, fully visible for 2 s, then fading out over the
third second (2–3 s, ease-in) and removed. The newest notice is in front at the stack's place; the one that was in front moves
behind it (180 ms ease-out; instant with reduced motion, the fade stays): 3 px lower, so its bottom edge peeks out below the
front one, its text and icons hidden, and, when it is wider than the front one, scaled down uniformly from its bottom centre to
the front one's width (scale = front width / its width, recomputed when a newer notice arrives; a narrower one is not scaled; a
mode notice too). At most one notice is behind: a newer notice removes any older one at once. The one behind keeps its own
timeline (it fades and is removed on schedule, scaled or not). A notice with the same text as a shown one replaces it (the front
one is shown again from the start, no stacking).
- Paste replaced: a document paste over a non-empty text selection shows "Paste replaced text" with T → T (the `PasteNotice`
  plugin's appendTransaction on the paste transaction, uiEvent 'paste'). A paste at a caret shows nothing; Ctrl+Z undoes the paste.
- Paste refused: a document paste that would replace a node-selected block does nothing and shows a mode notice with the
  block's toolbar icon (flowchart canvas: a canvas that is a flowchart as in flowchart mode above, Workflow; image: a canvas
  holding one image item, ImagePlus; canvas, Frame; plan chart, SquareKanban; table; box; rule; any other block, Square):
  "Enter Canvas Mode to paste" (any canvas), "Open the plan to paste" (plan chart), else "Place the caret to paste"
  (`PasteNotice`'s filterTransaction). A node-selected whiteboard takes the paste itself (§6c), so it is never replaced.
  Board pastes (items, images, Mermaid) add and never replace, so they show nothing; nor does a paste over the selected text
  of a board text being edited (an edit starts with all of it selected, placeholders included, so replacing it is the usual intent).

Options panel: a floating panel at the palette's pointer (below it, above when there is no room; shadcn Popover, not a blocking dialog) titled with the entry's label, holding
the same controls the rail flyouts / ribbon / toolbar menus use for it (no duplicated control code): Pen and Eraser: colour,
width, style; Shape kinds: shape (the shape list), line colour, width, style, fill, fill colour; Text colour and Highlight: the swatches; Font:
the font list; Size: the size list; Block style / headings: the block styles; Align: the four alignments; Snapping: the rules;
Background: the backgrounds; Connector: route, heads, line colour, width, style, dash, line jumps; selected text item or connector: its
ribbon controls. Changes apply live. Escape, Enter or a click outside
closes it and returns focus as above.

---------------------------------------------------------------------------------------------------
## 7d. Quick tools (Ctrl+Tab)

A merged tool island summoned at the mouse pointer, so tools are one short move away wherever the user works.

- Ctrl+Tab (also while a canvas is edited, a text item or an input has focus; never moves keyboard focus) shows the
  Quick tools island at the pointer: centred horizontally under the pointer, its top a few px below it, kept fully inside the
  window (above the pointer when there is no room below). It appears at the pointer from the first frame and only fades in (100 ms; no scale or slide) and
  never takes focus: the document keeps its selection, a board keeps focus, a text item keeps its caret.
- It stays until Escape, a pointer-down anywhere outside it (on a board that click only closes it, §6c Dismiss-only clicks;
  elsewhere it still does its normal job, e.g. a toolbar button works), or Ctrl+Tab again. Releasing
  Ctrl or Tab does nothing. Using a control in it does not close it (so several formats / tools can be applied in a row), except
  that it closes when the mode it was opened for ends (e.g. focus moves from the text into a board: Ctrl+Tab again shows the
  board version). Opening a menu, select or colour flyout from it keeps it open; those popups open next to it.
- Contents = the bottom toolbar island and the §6c rail merged into one compact grid island (wrapping rows of icon buttons,
  at most about 10 buttons per row, groups separated by thin separators), with each control appearing once (no duplicates:
  Undo / Redo, Bold, Italic, …, which exist in both, appear once) and without the font family select. Same commands, icons,
  tooltips, active and disabled states as the originals (shared definitions, no copied logic).
  - Undo, Redo, Add image and Snapping are not in the island (the left hand is on the keyboard for their keys; images come by
    paste / drop). The most used tools come first, nearest the pointer.
  - Text mode (caret in the document): block style, size | Bold, Italic, Underline, Strike, Sub, Sup, Code | Text colour,
    Highlight | Align, Bullet list, Ordered list | Quote, Code block, Rule | Table, Box, Link, Whiteboard, Add canvas |
    Presets, Clear formatting (plus the table operations while the caret is in a table, as in the toolbar).
  - Board mode (a board is active, also a canvas being edited): Select, Text, Pen, Eraser, Shape, Connector | Duplicate, Front, Back,
    Arrange, Delete | Add canvas (whiteboard only), Background | Fit height, Delete board (whiteboard only). The active tool's options
    show in rows on top of the island, the first row next to the island, the card's left edge at the pointer (where the
    island was summoned, then where the last click in it was, e.g. a tool button) so the line colour is right above it: line colour, width, style (shape tool: then shape, fill, fill colour; connector tool: then route, heads,
    dash, line jumps); below the island when
    there is no room above. The rail's own
    flyout for that tool stays closed meanwhile. While a single item is selected, that item's ribbon controls in a last row.
- Compact density, the same look as the other islands (card at 70 % opacity with a slight 2 px background blur so the page shows through, border, shadow; the §7c palette uses the same
  translucent card), z-index above the islands and the ribbon,
  below dialogs.
- In the plan workspace (§7f) Ctrl+Tab does nothing: it has no board and no document to format.

---------------------------------------------------------------------------------------------------
## 7e. Persistent undo history

- Undo / redo history persists per draft across closing and reopening the app (and switching drafts): after reopening a draft,
  Ctrl+Z steps back through the same steps as before, and redo still works where it did.
- Retention: the last N undo steps per draft (and the redo steps after them), `settings.historyLimit` (default 50, 0…500). The in-memory history keeps the same N
  (UndoRedo `depth`). 0 keeps no history after closing (in memory it still keeps 50 while the draft is open).
- Storage: `drafts/<id>.history.json` next to the draft, written with the draft's autosave (atomic like drafts, through new IPC
  `api.drafts.loadHistory(id)` / `api.drafts.saveHistory(id, data)` with the same id validation), moved to the trash with the
  draft. Content: the document before the oldest retained step, then the recorded transactions of the retained steps (step JSON
  and `time`) grouped by undo step with the selection before each step, and how many of those steps are currently undone. A change
  the history does not record (`addToHistory: false`) restarts the log at the current document. Image data URLs
  (whiteboard / canvas items) are stored once in a table keyed by a hash and referenced from the doc and steps, so a file holds each
  picture once.
- Restore: keep prosemirror-history; on opening a draft, rebuild its history by replaying the recorded transactions on the saved
  base document through the editor with history on (same `time` values; each step's first transaction carries the closeHistory flag
  and the others join its step, so the grouping is identical), then undo the undone count; the next change starts a new step. None
  of this marks the draft dirty, scrolls, or shows in autosave. If the rebuilt document does not equal
  the draft's saved document, or the file is missing, unreadable or from another schema, the history starts empty: opening a draft
  never fails because of it.
- Settings dialog: "Undo history" number input (0…500, default 50) with the help text "Steps kept per draft, also after closing
  the app (0 = none after closing)". A change applies to the open draft at once (the editor remounts with its history rebuilt).

---------------------------------------------------------------------------------------------------
## 7f. Plan workspace

One plan per forum thread (`plans/<id>.json`, §3; docs/plans/gantt-kanban.md §3, §6), shown in the §7g workspace host. Roadmap
A2 builds the Board, A3 the Backlog and the plan chart (§6e), A4 the Gantt.
- Store (`src/app/plans.js`): every plan file parsed (`parsePlan`, src/plan/plan-model.mjs) at startup, links to drafts that no
  longer exist dropped (`pruneDrafts`, written back). `dispatch(commandId, args)` is the only writer: the descriptor of
  `src/plan/plan-commands.mjs`, its gates (`PLAN_GATES`, else `gates.mjs`; failing → `precondition_failed` with
  `{failed: [{gate, message, fix}]}`), then its reducer. Reducer codes `not_found`, `already_exists`, `invalid_args` and
  `precondition_failed` are returned as they are, every other one as `refused` with `data.code`; a failed UI command toasts its
  message. Settings values a command returns (`tags`, `draftTags`) are shown and sent at once, the plan written after them; plan
  writes are coalesced 300 ms per plan in one chain. `flushPlans()` (Ctrl+S, opening a draft, Back to editor, push) writes them
  at once and closing the window waits for them. A failed write toasts "Could not save the plan: …"; the next change writes again.
  The store follows settings: a global tag deleted in Settings unmaps the plan column that follows it (no undo entry); a ticket's
  `completedAt` is set and cleared as its (derived) status enters and leaves the done column. Auto-schedule (the plan's
  `autoSchedule`, ⋯ menu): while on, a command that changes dates, dependencies or the calendar (`plan.update`, `plan.holidays.*`,
  `plan.tickets.create` / `.update`, `plan.deps.add` / `.update`, `plan.import`) also moves every ticket that starts before its
  predecessors allow to its earliest start (`autoScheduled`, src/plan/schedule.mjs), in the same undo entry; the first time in a
  session a toast says "Auto-schedule moved n tickets." Turning it on moves the conflicting tickets at once.
  `dispatchAll(planId, [[commandId, args]])` runs several builder commands as one change and one undo entry (a Gantt Shift-move,
  a holiday moved to another date).
- Undo: one stack per plan, in memory only (50 entries; a new command clears redo). Every command is one entry holding the plan
  before and after and the tags of the drafts it changed; undo / redo put those drafts' tags back over the current ones (other tag
  changes survive). A global tag a drop created stays (settings have no undo). Header Undo / Redo and Ctrl+Z / Ctrl+Y /
  Ctrl+Shift+Z in the workspace; the document's history is never touched.
- Opening (Plans tab, Ctrl+Alt+P, palette, a thread row's "Plan board"): the plan of that thread, else of the selected thread,
  else of the open draft's thread; a thread without one asks "Create a plan board for "<thread>"?" (Create). Without any thread
  the plan picker lists every plan by thread ("Without a thread" last; Open, Delete). Opening resets the selection and filters
  and shows the last tab shown (`settings.planTab`, kept across restarts); startup restores `lastView` (a plan that no longer
  exists: the editor). Opening a draft from a card goes back to the editor first.
- Header (36 px, `text-xs`): sidebar button, plan title (tooltip: the thread URL), Board | Backlog | Gantt (Alt+1–3; the tab is
  kept in `lastView` and `settings.planTab`), filter input ("Filter… ( / )": title, description and `#num`; Escape clears it), Labels and Priority filter
  menus (checkbox items; any of them matches), Hide done toggle, Saved views menu (a view applies its filters and tab; "Save
  current as…" asks a name → `plan.views.add`; × on a view → confirm → `plan.views.remove`), + Ticket, Undo, Redo, ⋯ (Labels…,
  Columns…, Units…, Calendar…, Set baseline (copies every scheduled ticket's start and end; "Set baseline again" once set),
  Clear baseline, Auto-schedule (checkbox), Rename plan…, Insert into draft (submenu: "This view (<tab>)" = a live plan chart
  (§6e) of the tab with its filters, filter text and the card fields / Backlog columns shown (the Gantt: its zoom and what it
  shows), then one entry per saved view; back in the editor, after the selection), Copy as Markdown, Copy as Mermaid, Export plan… (the JSON as a download), Import
  plan… (a plan JSON replaces this thread's plan after a confirm naming both ticket counts: a new id, the replaced file to the
  plans trash), Delete plan… (confirm, naming how many drafts show it in a plan chart; to the plans trash)), Back to editor.
  Header buttons never take the focus.
- Board: "No status" first while it has cards, then the plan's columns, 260 px wide (`w-80` at the 13 px root size, §7b), the strip scrolling sideways. Column header:
  colour dot, name (double-click or the menu's Rename: edited in place), a Tag glyph when it follows an existing global tag
  (tooltip "Draft cards follow the tag "<name>""), a green CircleCheck on the done column, the card count or count/WIP limit (red
  when over; never blocks a move), + (quick add) and ⋯ (Rename, Move left, Move right, Set as done column, Edit columns…, Delete
  column…; no Delete on the only column). "+ Column" after the last column adds "New column" (next free colour) with its name
  open for editing; at 10 columns it is disabled with the tooltip "A plan has at most 10 columns".
- Cards: the title (2 lines; a milestone icon before it), then `#num`, the priority icon, label pills, the due date (`end`: red
  when past and not done, amber today), checklist `done/all`, the estimate (tooltip "= n d" for a custom unit), a Ban icon when
  a predecessor is not done (tooltip lists them), the linked draft (click opens it), the pushed tick, and in "No status" a badge
  with the draft tag that no column follows. Draft cards (the thread's drafts that no ticket links): title, a "draft" badge, the
  pushed tick and a hover "Convert to ticket". The ⋯ button or a right-click opens the card menu: Status, Priority, Labels,
  Milestone, Open draft / Link draft…, Delete… (draft cards: Status, Open draft, Convert to ticket); it acts on the selection when
  the card is in it.
- Click opens the ticket dialog and selects the card; Ctrl+click toggles it in the selection; Shift+click selects the range from
  the focused card within its column; a click on the strip's background or a column's empty space clears the selection (§7
  Background clicks). Dragging a card (after 4 px; the whole selection when the card is in it) shows an insertion
  line, highlights the column under the pointer and scrolls the strip near its edges; the drop is one `plan.tickets.move`, placed
  before the card under the pointer, else after the column's last ticket (dropping in place does nothing). Linked tickets and
  draft cards change only their draft's tag (as the sidebar's Tag menu; "No status" untags). Over a column that follows no tag
  they show a dashed "Follows no status tag: drop to create one", and the drop asks "Create a matching tag "<column>"?" (Create:
  a global tag with the column's name and colour at the end of Settings > Tags) or, when a global tag of that name follows no
  column of the plan, "Use the tag "<name>" for this column?" (Use tag). Confirming is one command (one undo entry) that maps
  the column and tags every dragged draft; Cancel changes nothing.
- Quick add: + in a column header (or N with a card of that column focused) opens an input at the top of the column; Enter adds a
  ticket there (priority Medium) and keeps it open, a multi-line paste adds one ticket per line, Escape or leaving it empty closes it.
- Keys (focus in the workspace, not in an input or a popup): ←/→/↑/↓ move the focused card, Shift+←/→ move the selection to the
  neighbour column (asking as a drop does), Shift+↑/↓ reorder a ticket in its column, Enter opens the focused card (a draft card:
  Convert), N new ticket (the Board: quick add; Backlog / Gantt: the dialog), D moves the selection to the done column (all
  already done: to the column before it), C converts a draft card, Del / Backspace deletes the selected tickets (confirm), Ctrl+A
  selects every visible card, / focuses the filter, Alt+1–3 switch tabs, Escape clears the selection (it never leaves the page, §7g).
- Ticket dialog: New (+ Ticket, N outside the Board, Convert to ticket): opens with the plan's first column (Convert to ticket: the
  draft card's status) and priority Medium, the defaults of `newTicket` that any `plan.tickets.create` / `plan.import` without
  them also gets (an explicit value is kept); every field and row is kept in the dialog and OK sends one `plan.tickets.create`
  (title required; dates both or neither, end ≥ start); Cancel. Edit (card click, Enter): every field
  set runs at once as its own command and undo entry: title and description (Enter or blur), status (`plan.tickets.move`;
  disabled while a draft is linked, whose tag decides), priority, estimate + unit (`= n d` shown for a custom unit), start + end
  (sent once both are dates with end ≥ start, or both empty; otherwise an inline message), milestone, progress (5 % steps, sent on
  release; disabled in the done column), parent (not itself or below it), linked draft (link / unlink by the tag rules; a ticket
  moved by linking toasts "Moved to <column>: …"). Rows: labels (check / uncheck; "New label…" adds a plan label and checks it),
  dependencies (pick the predecessor, then type and lag; a cycle or parent refusal shows inline), checklist (add with Enter, check,
  text, up / down, remove), links (add once the URL is http(s), URL, title, open, remove; a forum URL opens in the forum window).
  Removing one row does not confirm (Ctrl+Z restores it). Footer: created / updated / done times, Delete… (confirm), Close.
- Date fields (ticket dialog start / end, Calendar… week 1 and holidays, Backlog start / end, the chart bar's Options range) are
  `DateField` (src/app/components/DateField.jsx): the native date input for typing (dd/mm/yyyy; YYYY-MM-DD values; Chromium's
  own picker indicator hidden) and a calendar button at its right end (not in the Tab order; Alt+↓ or F4 in the box) that opens the
  shadcn Calendar in a popover: Monday first, today and the selected day marked, the plan's non-working weekdays and holidays
  muted, previous / next month and month / year menus (±10 years). A picked day fills the box and closes the calendar (in the
  ticket dialog's edit mode: one start + end field set, one undo entry); Escape closes only the calendar; the focus goes back to
  the box. Typing keeps each field's rule (the ticket dialog sends on change; the others on Enter or leaving the field).
- Columns… / Labels… / Units… (the ⋯ menu): every row change runs at once as its own command and undo entry; one Close button.
  Columns…: colour (sent when the native picker closes), name, the status tag it follows (tags no other column follows, or "No
  status tag"), WIP limit, a Done toggle, up / down, delete (→ Delete column…). Delete column… (column menu or dialog): "Move n
  tickets from "<column>" to [column | No status]" (default the left neighbour), with "n linked drafts keep their status tag and
  show in "No status"" and "Done moves to "<last column>"" when they apply. Labels…: colour, name, delete (confirm "Remove the
  label "<name>" from n tickets?"), Add label (named "New label", its name selected). Units…: the fixed `d` row (working day),
  then per custom unit its name and "= n d" (added or changed once both are valid; an inline message otherwise), a Default toggle
  (also on `d`) and delete (confirm; "n tickets estimated in <unit> are converted to days (e.g. …)"). Calendar… (dialog
  `planCalendar`): the working weekdays (Mon … Sun toggles; the last one cannot be turned off) → `plan.update {calendar:
  {workdays}}`, the first day of week 1 (a date; × clears it) → `plan.update {calendar: {weekOne}}`, the holidays (a date each,
  sent on Enter or leaving it; a changed date is one entry; × removes) and Add holiday (an empty date row, added once a date is
  set) → `plan.holidays.add` / `.remove`.
- Settings > Tags: deleting a tag that plan columns follow also confirms and adds "n plan columns stop following it (their
  tickets stay; linked drafts move to No status)".
- Backlog: the tickets as a tree (`order`; children indented 16 px, a chevron collapses a parent), filtered like the Board; a
  sticky header row and one 32 px row per ticket: drag handle, #, title, status (select: the columns and "No status", moved as a
  drop is, incl. the create-tag question), priority (select), labels, estimate (tooltip "= n d"), start, end (click: a date field;
  a picked day, Enter or leaving it sends start + end as one field set, the other date following when needed; empty clears both;
  Escape cancels), progress, deps (a Ban icon while a predecessor is not done; their #), linked draft (click opens it), checklist
  `done/all`. A parent shows its summary estimate, dates and progress, muted and read-only. The Columns menu (top right) hides
  any column but the title; hidden columns and collapsed parents are kept per viewer in `localStorage` `daf-writer.plan.<planId>`.
  A header click sorts by that column (#, title, status order, priority, estimate in days, start, end; again: the other way); while
  sorted the rows are flat, the handles are off and a "Sorted by … · Clear sort" chip ends it. Dragging a handle (after 4 px,
  the selected siblings with it) shows an insertion line between siblings and is one `plan.tickets.reorder`; with Alt held the
  row under the pointer is highlighted and the drop makes it the parent (`plan.tickets.update {parent}`; refused cycles toast).
  Click opens the ticket dialog and selects the row (Ctrl+click toggles, Shift+click selects a range); a click around or below
  the rows clears the selection (§7 Background clicks). Keys: ↑/↓ focus,
  Shift+↑/↓ reorder among siblings, →/← expand / collapse, Enter opens, Del / Backspace deletes the selection (confirm), Ctrl+A
  selects every row, Escape clears the selection. Footer: tickets, the estimate sum in days (tooltip: the sums per unit), done %,
  blocked.
- Gantt (`components/plan/Gantt.jsx`; geometry `ganttLayout`, src/plan/gantt-layout.mjs; the drawing is the plan chart's, §6e,
  in the app colours): a toolbar row (Day | Week | Month | Quarter | Fit; Today (scrolls today to the left third); Show menu:
  Dependencies, Critical path, Baseline, Today line, Weekends (off: an axis of working days), Task list, Unscheduled tickets
  (default on), Week numbers (needs week 1 in Calendar…); "n conflicts" when any; a one-line gesture hint). These view options are part of the header's filter options
  (saved views and Insert into draft take them; opening the plan resets them: Fit, critical path and baseline off). Then one
  scroll area: the task list (title by depth with a milestone icon, start, end, working days; a parent's summary dates muted;
  min 160 px, its right edge drags the width, kept per viewer as `ganttListW`) and the chart, both sticky (header row on top,
  task list at the left); every ticket that passes the filters (with its parents) has a row, in tree order and filtered like
  the Board, dated or not: an unscheduled ticket shows "Unscheduled" (muted) across Start / End / Days and an empty lane, a parent
  without a scheduled child "—" and no bracket (Show › Unscheduled tickets off hides them). The chart in a draft keeps
  scheduled tickets only. With no row: "No ticket matches the filters." (a plan without tickets: "No tickets yet." and a
  + Ticket button).
  The axis (ticks, shading, grid, today line, row lines) always fills the chart's width and runs past the tickets
  (`ganttLayout(…, {fill})`; the chart in a draft keeps §6e's range): one zoom unit before the first date (3 days at Day and Fit,
  7 at Week, 31 at Month, 92 at Quarter), at least two weeks (or that unit) after the last, then days up to the right edge (Fit
  fits the tickets with that lead-in and tail, at most 36 px a day, and fills the rest with days); with no scheduled ticket it
  runs around today. A view's `range` sets the start / end instead (no lead-in or tail there; with an end, no filling).
  Scrolling sideways to within 100 px of either end, or a gesture held in the 48 px edge zone (it scrolls, as the Board does),
  grows the axis by half a screen there (the start only between gestures, the days on screen staying in place), until the tab
  is left. While the tab stays open the axis only grows: its start and end are kept as limits and Fit's scale is kept (until
  the chart's width changes), so a released drag never moves it (a start that moves earlier keeps the days on screen in place);
  a zoom step, Weekends or a range recompute it, as does coming back to the tab. A gesture also keeps the start as it is.
  Drawing: header tick rows (day: month / day; week: month / week start or "Wk n"; month: year / month; quarter: year / Qn),
  weekend and holiday shading, a dashed accent today line, bars (rx 4; the first label's colour, else the column's, #555 for
  No status; progress darker; the title inside when it fits, else after it), milestone diamonds, parent brackets over the
  summary, baseline ghost bars under the bar, critical bars (and links between them) outlined red, conflicts outlined orange
  (tooltip "Starts before its predecessors allow (earliest <date>)"), a Ban glyph on blocked bars, orthogonal dependency lines
  with an arrowhead at the successor. Ctrl + wheel over it steps the zoom keeping the day under the pointer (from Fit: the
  nearest zoom); Shift + wheel scrolls time. Gestures (whole working days; the plan is unchanged until the release, then one
  command and one undo entry; with a popup open a press only closes it): a bar's body moves it keeping its working days (Shift:
  every successor, transitively, by the same working days, one entry); its 8 px ends resize it (at least one day; a milestone
  moves); the triangle under a focused or hovered bar sets progress in 5 % steps; the dots shown beside a hovered bar draw a
  dependency: dropped on a bar's left half `*S`, right half `*F`, from the start dot `S*`, from the end dot `F*` (FS, SS, FF,
  SF) → `plan.deps.add`; an illegal target (itself, a cycle, a parent, an existing link) draws the ghost red and the drop toasts
  why; Alt-dragging a dependency line changes its lag by one working day per day dragged → `plan.deps.update`. A click selects a
  bar (Ctrl toggles, Shift a range) or a dependency (drawn thicker); a click on empty space (also below the rows, §7 Background clicks) clears both; double-click opens the
  ticket dialog (a dependency: the successor's, scrolled to its dependencies); right-click (bar or task row) opens the menu:
  Open…, Add subtask… (the new ticket dialog with that parent), Status, Priority, Labels, Milestone, Remove dates, Open draft / Link draft…, Delete… (on the selection when the bar is
  in it). An unscheduled ticket is scheduled in place: a click in its lane gives it that working day (start = end), a drag
  across the lane draws its span (one undo entry each); a faint ghost bar marks the day under the pointer; a parent's lane says
  "Schedule its subtasks" instead. A ticket created in the Gantt tab (+ Ticket, N, the empty chart's + Ticket, Add subtask)
  and left without dates in the dialog starts today, or the next working day (Add subtask: on the parent's start, today when
  the parent has none), and lasts its estimate in working days (rounded up, at least 1; a milestone 0); tickets created on the
  Board or the Backlog stay unscheduled.
  Dragging a task-list row reorders it among its siblings and Alt-dropping it on a row makes that row the parent, as a Backlog
  handle does (drag.js `dragRows`).
  Keys: ↑/↓ focus a row, Shift+↑/↓ reorder among siblings, ←/→ move the focused bar a working day, Shift+←/→ its end, Ctrl+←/→ its start, Tab / Shift+Tab cycle
  the focused bar's dependencies, Del / Backspace removes the selected dependency, else deletes the selected tickets (confirm),
  Enter opens, T today, + / − zoom, Ctrl+A selects every row, Escape clears the selection and the dependency.
- Not built yet: swimlanes, collapsed Board columns, the L / P menu keys and the other per-viewer `localStorage` settings of
  docs/plans/gantt-kanban.md §3.4.

---------------------------------------------------------------------------------------------------
## 7g. Sidebar footer and workspaces

The main column shows the editor or one workspace in its place: the plan workspace (docs/plans/gantt-kanban.md §6) or the
flowchart library (§6f; docs/plans/flowchart.md §5.10). A workspace replaces the editor column (no split view). These are pages,
not overlays: the sidebar navigates between them (a page swap, no fade or scrim), and nothing toggles.
- Navigation: `showPage(type)` (views.js; 'editor' | 'plan' | 'flows') shows that page and does nothing when it is the one shown.
  The sidebar's draft rows go to the editor page at once: a row opens its draft (`openDraft`, which shows the editor after the
  draft loads; a failed save or load stays on the page) and the open draft's row (also the unsaved "Untitled draft" row) just
  shows the editor; **New draft** and selecting a thread (or All drafts) also show the editor. Leaving commits and flushes as
  `closeWorkspace()` does and focuses the editor. Deleting a draft from the sidebar stays on the page shown. The page shown is
  highlighted in the sidebar: on the editor page the open draft's row, on a workspace page its footer tab (no draft row then).
- State: `state.view` = `{type: 'editor'}` (default) | `{type: 'plan', planId, tab}` | `{type: 'flows', flowId}` (store.js).
  `src/app/views.js` switches it: `openWorkspace(view, {startup, remember})` commits an open board text edit, closes the canvas
  being edited, clears the active board's tool, saves the draft (unless `startup`; a failed save keeps the editor), moves a node
  selection to just after its node, blurs the editor, shows the workspace, focuses `#workspace-root` on the next frame and saves
  `settings.lastView` (unless `remember: false`). `closeWorkspace()` commits board edits and flushes the plan and flowchart writes,
  shows the editor, focuses it on the next frame (its selection restored, no scroll) and saves `lastView: {type: 'editor'}`.
  `src/app/plans.js` (`openPlan`, `initPlans`, `flushPlans`, `insertPlanChartDialog`) and `src/app/flows.js` (`openFlows`,
  `initFlows`, `flushFlows`, `insertFlowchartDialog`) are their features' stores (§7f, §6e; §6f).
- Layout (App.jsx): the editor page stays mounted behind a workspace, `visibility: hidden`, no pointer events and `inert` (its
  layout is kept: page width, zoom and the export width probe still measure it, so autosave and Push keep working). The workspace
  (`#workspace-root`, focusable, `absolute inset-0` over the editor area, app background) holds `PlanPage` or `FlowsPage`, each with
  a header row (`h-9`: 29 px at the 13 px root, §7b): the sidebar button (the one of the editor's corner), the title, and **Back to editor** (outline, right; a shortcut to the open draft). The
  toolbar island and the corner sidebar button show in the editor only. The §6c rail shows in the editor and, in the flowchart
  library, only while a board is active (the library editor's): never for the hidden document; never in the plan workspace.
- Viewport: each page's viewport is the area where its content is viewed and edited, marked `data-viewport`: the editor page's
  `#editor-area`; the library editor's `#flow-area` (the board's view right of the shape panel, so it follows the panel's collapse
  and width); the library list's and the plan workspace's page below its header row. `src/app/viewport.js` `viewportRect()`
  measures the shown one (the last mark in document order, below a `header` it contains). "Centred in the view" (and "the
  top centre of the view") always means this viewport, never the window or the main column: the §7c notice stack and the §7h
  transcript pane (one bottom column, §7c Notices) are centred in it, and measured again when the view changes or the viewport, the main column or the window
  changes size.
- Notices: the transient notices (tool search, Canvas Mode, paste replaced) are one stack above the toolbar island in every
  view, centred in the viewport (§7c Notices); nothing shows at the top or centre of the view.
- Sidebar footer: under the scrolling sections, a fixed footer (`border-t`, `p-1`) with two full-width ghost tabs, 32 px high,
  stacked: **Plans** (SquareKanban, hint "Ctrl+Alt+P") above **Flowcharts** (Workflow). The tab of the page shown is highlighted
  (`bg-accent`, `aria-current="page"`); clicking it does nothing, clicking the other switches page. The footer is part of
  the sidebar, so it is hidden while the sidebar is collapsed (Ctrl+Alt+P reaches the plans then).
- Keys: Ctrl+Alt+P shows the plan workspace from anywhere; on it, nothing (no toggle). Ctrl+Alt+F (editor only, also while a canvas
  is edited) runs Insert flowchart; it stays that, not a navigation key. Escape at page level does nothing: it never leaves a
  page; only a page's own steps use it (a popup, a selection, a tool, the filter; the library editor goes back to its list).
  Ctrl+S, Ctrl+Space, Ctrl+Tab and window zoom stay global; Ctrl+K, Ctrl+\,
  Ctrl+Alt+W / C and Alt+1–9 do nothing in a workspace. Ctrl+Tab does nothing in a workspace without an active board; the tool
  search there lists no text entries.
- Focus return (`refocusEditor`, `returnFocus` after a popup or the tool search): the editor; in a workspace its active board,
  else `#workspace-root`.
- Startup: after the drafts list, `initPlans()` and `initFlows()`; the draft opens as before; last, `settings.lastView` is applied
  (plan or flowchart library; the stores send an unknown plan or flowchart to the editor).
- Gates (`src/app/gates.mjs`, pure, Node-tested): `GATES[id] = {subject, test, message, fix}` and `can(id, subject, args?, param?)`,
  the preconditions the UI and the later agent commands share (docs/plans/agent-automation.md §3.7, flowchart plan §7.2): `doc.open`,
  `view.editor|plan|flows`, `node.board`, `node.canvas`, `board.active|whiteboard|selection|selectionMany|itemIs`, `doc.inTable`,
  `history.canUndo|canRedo`, `draft.hasThread|unpushed|pushed`, `flow.open|synced|unsynced|present`. The tool search's conditions
  (tools.js), the toolbar's Undo / Redo, table and insert controls, the sidebar's Push / Unpush and Push's thread check, the view
  switches in App.jsx and actions.js read them.
- Extension points for the features (each feature appends to its own module): tool search entries `TOOLS = [...CORE, ...PLAN_TOOLS,
  ...FLOW_TOOLS]` (`tools-plan.js`, `tools-flow.js`; groups 'Plan' and 'Flowchart'), form dialogs `FORMS = {...CORE, ...PLAN_FORMS,
  ...FLOW_FORMS}` (`components/plan/forms.jsx`, `components/flows/forms.jsx`), smoke sample blocks (`samples/plan.js`,
  `samples/flow.js`, before "End of sample."). Zoom around a point, middle-drag pan and Ctrl+wheel zoom live in `src/app/panzoom.js`
  (`zoomAround`, `bindPanZoom`), used by the editor area. `src/doc-utils.mjs` `flowRefs(doc, titleOf?)` lists the synced canvases
  (`[{path, flowId, label}]`, label = `titleOf(id)` else "Flowchart n").

---------------------------------------------------------------------------------------------------
## 7j. Browser

A tabbed web browser (`src/app/browser.js`, `components/BrowserPage.jsx`): a third workspace page (§7g), opened by the sidebar
footer's **Browser** tab (Globe, hint "Ctrl+Alt+B") or Ctrl+Alt+B from anywhere (`state.view = {type: 'browser'}`, gate
`view.browser`, restored by `lastView`), and a floating pane over every other page.
- Pages: one `<webview>` per tab (main window `webviewTag: true`) in the session `persist:browser`, so cookies and logins
  survive restarts (the user logs in once inside the app; Chrome's own profile cannot be shared). The session gets the forum's
  permission rule (clipboard and fullscreen only). The app's user agent drops the Electron and app tokens, but Google still
  refuses sign-in from an embedded browser (spoofing the UA, Sec-CH-UA and `navigator.userAgentData` did not change that), so
  Google sign-in uses the Sign-in-with-Chrome flow below.
- Sign in with Chrome (`src/chrome-signin.js`, IPC `browser.chromeSignIn`, test `test/chrome-signin.test.mjs`): on a tab at
  `accounts.google.com` a slim bar sits above the page with **Sign in with Chrome** (in the pane, a bordered box of its own).
  It launches the first installed Chrome, else Edge (Google accepts Edge), on a dedicated profile at `userData/chrome-signin`
  (never the user's own Chrome profile), opening `accounts.google.com/ServiceLogin?continue=https://myaccount.google.com/` with
  `--no-first-run --no-default-browser-check` and `DeviceBoundSessions` / `EnableBoundSessionCredentials` disabled, and with
  no remote-debugging or automation flags, so Google sees a plain browser. The user signs in and closes that window. The app
  then runs the same exe headless on that profile over `--remote-debugging-pipe` (no port), reads its cookies with
  `Storage.getCookies` (20 s timeout), and writes every cookie in that profile into the `persist:browser` session, not only
  Google's (partitioned cookies are skipped; cookie values stay in the main process and are never logged). Only one run at a
  time. If the launched browser exits within 3 s, a sign-in window from an earlier run is still open on that profile, and the
  flow stops with "The sign-in window is already open. Sign in there, close it, then try again." On success, if the tab is
  still on `accounts.google.com`, it goes to its `continue` URL when that is https on google.com or youtube.com (or a
  subdomain), else it reloads. Ceiling: Google may still bind or expire the session, so sign-in can need re-running from the
  bar. Cookies reach the profile only when its window closes normally, and session-only cookies are never written to it.
- Web layer (`WebLayer`, App.jsx after the browser page): a frame per tab (`TabFrame`, `data-tab-frame`), each holding the
  tab's webview, never moved in the DOM (a moved webview reloads its page), so tabs keep running whatever is shown. The layer is
  a stacking context over the main column: z 11 on the browser page (under its chrome), where the active tab's frame covers the
  page's slot (`[data-web-slot]`, below its header); z 44 on any other page, where each tab with an open pane is a floating pane;
  every other frame is hidden and inert.
- Tabs: `settings.browser = {tabs: [{id, url, title}], active}`, mirrored from `state.browser` 300 ms after a change; a new tab
  opens Google (`HOME`). The browser page shows the active tab. The browser page stays mounted behind the other pages (hidden
  and inert); only the shown page carries `data-viewport` and `#workspace-root`. With no tabs the browser page shows a
  **New tab** button. Going to the browser page (Browser tab, Ctrl+Alt+B, startup) opens no tab by itself unless
  `settings.browserAutoTab` (Settings > Browser > Open a tab on an empty Browser page, default off). Closing a tab closes its pane.
- Tab strip (`TabStrip`): each tab's title (else the host, 11 rem wide) with a close X (middle-click also closes), then **+**;
  the tabs wrap onto more rows (never a sideways scroll), the strip growing downwards. On the browser page it is in the header
  (row 1 grows with it, its buttons at the top) and the active tab is highlighted. On every other page (editor, plan, flowchart
  library) it floats at the top-left of the viewport (§7g `viewportRect`, below a page's header row; `data-browser-tabs`, z-25),
  always (with no tabs only its **+**): a tab toggles its pane: a click shows it (`openPane`), or minimizes it while shown (`closePane`; holding the tab leaves the pane's look as it is until the click),
  **+** opens a new tab in a new pane; the tabs shown in panes are highlighted. Neither leaves the page shown.
- Panes (`data-browser-pane`): any number at once, one per tab, `settings.browserPanes = [{tab, place}]` in stacking order (the
  last on top; frame z-index its place in the list; an old `settings.browserPane` {open, place} counts as one pane on the active
  tab), kept across restarts and pages and hidden on the browser page. A minimized pane keeps its place on its tab (`tab.place`,
  saved with the tabs) and reopens there at the same size (placePanel fits it to the viewport); any other new pane opens 2 rem down and in from the top pane
  (else at the default: the viewport's top-right below the strip, 48 × 40 rem); a press or the focus in a pane brings it to the
  top (`raisePane`). Each floats over the page's viewport like the assistant's panel (§7i): the page under its notch, movable from
  the notch and its border, resizable from its corners (10 px, `panel.mjs` placePanel / dragPanel / anchorPanel; minimum 26 ×
  14 rem), place as the assistant panel's (anchored to the nearer edges). Focus: a press on its chrome focuses its page; a pane
  has the focus while the focused element is in it (re-read after every focus change, as a focused webview fires no focusin in
  the host). Without the focus it is drawn at `settings.browserIdleOpacity` percent (Settings > Browser > Unfocused opacity, 10
  to 100 in steps of 5, default 70; no blur; its notch at 40% or more while `settings.browserNotchFloor`, Settings > Browser > Keep
  the pane's controls visible, default on), opaque again while dragged, and is click-through: the pane and its page take no
  pointer events (presses, wheel and hover reach what is under it), except the notch, where a press gives the pane the focus
  again (and can start a move). A page's new-tab link opens a tab in a new pane on these pages. Presses on a pane and the strip do
  not leave Canvas Mode (§6b). The browser keys act on the pane they are pressed in (a page's forwarded chord names its web
  contents); a new tab key there opens a new pane.
- Notch and resize mode: a tab on the pane's top edge (`data-notch`, 2 rem high, min(44 rem, the pane's width less 24 px) wide,
  centred, its top corners rounded, its feet flared into the pane's top edge by 10 px inverse curves: radial-gradient fillets,
  the card outside a circle and the border ring along it), holding the pane's controls: at its left Back / Forward / Reload and
  the compact address bar (`clamp(5rem, 30 %, 14rem)` wide: the domain until clicked, then the whole URL in the same width, the
  URL as its tooltip), in the middle the grip (with the notch's other empty parts, a move handle), at its right the zoom (while it
  is not 75 %), Open in default browser, the resize toggle (Scaling; Check while on, in #3d99f5) and Minimize, a 14 px yellow
  circle (#febc2e) with a minus, which closes the pane (the tab stays in the strip). No fullscreen button, no header row. The pane
  is placed in the viewport less the notch's height, so the notch stays in view. Resize mode draws a canvas item's selection
  (whiteboard.js): a 2 px #3d99f5 outline (1 px offset) and eight handles (#3d99f5 squares, 2 px white border; 12 px corners,
  10 px edge midpoints) that resize from that corner or edge (`dragPanel` takes edges 'n' | 'e' | 's' | 'w' too); the page is
  covered by a blue tint with the hint "Drag the blue squares to resize. Press Enter or Esc when done." and takes no input; the
  pane holds the focus and stays opaque. Enter, Escape (stopped there, so Canvas Mode stays), the toggle or a press outside the
  pane end it, the page getting the focus back. The 10 px corner zones and the notch drag still work outside resize mode.
- Panes stack: the browser panes (their layer), the assistant's panel (§7i) and the background window's pane are z-44, over all app chrome
  (toolbar, rail, ribbons, notices, z-40 and below) and under the agent prompt (z-45), menus, popovers, tooltips and dialogs
  (z-50).
- Chrome (browser page): header row 1 the sidebar button, the tab strip and **Back to editor**; row 2 the nav bar (`NavBar`:
  `NavButtons`, `AddressBar`, `PageButtons`, which the pane's notch shares): Back / Forward / Reload, the address bar (`data-browser-address`: Enter loads a URL, a bare host gets `https://`,
  anything else is a Google search; Escape restores the URL) and **Open in default browser** (window.open, main's
  `shell.openExternal`).
- Keys: Ctrl+T new tab, Ctrl+W close tab, Ctrl+L the shown address bar, Ctrl+R / F5 reload, Alt+Left / Alt+Right back / forward,
  on the browser page, in the pane and inside a page (main.js forwards them from a webview as `browser.event` {type: 'key'}). A
  link to a new tab (`setWindowOpenHandler` disposition foreground / background tab) becomes a tab (`browser.event` {type:
  'open', url}); a popup (window.open: SSO logins) is a child window of the main window in the same session.
- Zoom: each tab has its own page zoom (`tab.zoom`, kept with the tabs; none means `DEFAULT_ZOOM` 75 %), in Chrome's steps (25,
  33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300 %). Ctrl+wheel over the page (main.js forwards the webview's
  `zoom-changed`) or over the pane's chrome zooms one step; Ctrl+= / Ctrl+- / Ctrl+0 (also Numpad + / - / 0) zoom in, out and
  back to 75 %, inside a page (forwarded) and in the pane or the browser page (there they never zoom the window, actions.js).
  The webviews use `setZoomMode('isolated')`, so two tabs on one site keep their own zoom. WebTab applies the tab's zoom once
  its page is ready (dom-ready). The nav bar shows the zoom as a button (Reset zoom, Ctrl+0) while it is not 75 %.
- Tool search (§7c, group App, tools.js): **New browser window** (`browser-new`: a new Google tab in the pane, on the browser
  page a new tab there), **Browser page** (`browser-page`, Ctrl+Alt+B; not on the browser page) and **Close browser pane**
  (`browser-close-pane`, only while the pane is open over this page). All `headless: false`.
- Not done: downloads use Electron's default save dialog; no history, bookmarks, find in page or tab drag.

---------------------------------------------------------------------------------------------------
## 7k. Keybinds

Every command shortcut of the app is a binding the user can change in Settings > Keybinds.
- Registry (`src/app/keys.mjs`, pure, Node-tested, also imported by main.js): `DEFS` = [{id, label, group, scope, keys (the
  default chords), shadows?}] in the order Settings lists them, in the groups General, Text, Insert, Boards, Plans, Flowcharts,
  Browser (94 bindings). A chord is "Ctrl+Alt+Shift+K" (modifiers in that order), the key named from KeyboardEvent.code (the
  physical key: letters, digits, "Num1" / "Num+", "Left" / "Up", "Del", "Esc", "Space", punctuation as itself); Meta counts as
  Ctrl. `chordOf(event)` takes a DOM KeyboardEvent or Electron's before-input-event input. A binding may have several chords
  (Reload: Ctrl+R and F5) or none. Fixed, not in the registry: keys that move inside widgets (Enter, Esc, Tab, arrows and
  Backspace in menus, lists, dialogs, text boxes and the chat box; board arrow nudges, Ctrl+Arrow quick-connect, Alt+Arrow to the
  connected item, Tab / Enter / F2 on board items; the plan views' arrow, Shift+arrow, Delete and Enter keys) and TipTap's
  editing keys (Enter, Backspace, list and table Tab, Shift+Enter).
- Storage: `settings.keybinds = {id: [chord]}` holds only the bindings changed from their defaults (`overridesOf`); an empty list
  unbinds. `effective(DEFS, overrides)` gives every binding's chords. Runtime (`src/app/keybinds.js`, no React): `setKeybinds`
  (actions.js applySettings), `keyIs(id, e)`, `keyAmong(ids, e | chord)`, `keyLabel(id)` (the first chord, '' when unbound) and
  `withKey(title, id)` ("Undo (Ctrl+Z)"). App.jsx re-renders on a change, so tooltips, tool search (`entry.key`, a binding id;
  `entryKey`), menus and hints show the current chords. main.js loads keys.mjs before the window and refreshes its chords when
  settings.keybinds is saved: Developer tools, and the browser's bindings, which it forwards from inside a page as
  `browser.event` {type: 'key', chord} (only bound chords; others reach the page).
- Handlers: actions.js (global and editor keys), the text keymap (extensions.js `TextKeys`, a ProseMirror handleKeyDown at
  priority 1100: a chord bound to a text command runs it; a TipTap chord for one of those commands that is no longer bound to it
  does nothing), whiteboard.js (board commands, tools via `toolKey(event)`, also on a node-selected whiteboard), the assistant
  (Assistant panel), dictation (Hold to dictate: held until its key or one of its modifiers is released), the plan page, Kanban,
  Gantt, the flowchart library and shape panel, and the browser (`browserKey`). Undo and Redo are one pair of bindings for the
  editor, boards, plans and flowcharts. Defaults now match exactly: Save is Ctrl+S only (so Ctrl+Shift+S is Strikethrough), and
  Code block has no default (TipTap's Ctrl+Alt+C is Insert canvas).
- Warnings (never block Save): under each row, for chords the user chose (a binding's own defaults are the app's known choices):
  Windows's use of the chord (`windowsUse`: system chords Windows takes first, such as Alt+Tab, Alt+F4, Ctrl+Esc and PrtSc;
  standard Windows keys such as Ctrl+C, Ctrl+V, Ctrl+Z, Shift+F10 and text navigation; Ctrl+Alt chords that are AltGr characters on
  many layouts; plain typing keys in scopes where text boxes take keys), and the app's own collisions (`collisions`: another
  binding on the same chord whose scope can be active at the same time; `global` overlaps all, `editor` overlaps `text` and
  `board`, `board` overlaps `flows`; `shadows` marks an intended take-over, the browser's zoom keys over the window zoom). The
  section's header counts the bindings with warnings.
- Settings > Keybinds (`components/KeybindsSection.jsx`): a filter box, Reset all, then per group each binding: its label, its
  chords as buttons (click: record a replacement; x: remove), + (record another), and a reset arrow while it differs from the
  default. Recording takes the next chord pressed (a lone modifier waits; Esc cancels; a press elsewhere cancels); nothing else in
  the app sees those keys (window capture, stopImmediatePropagation).

---------------------------------------------------------------------------------------------------
## 7l. Onboarding tour

A first-run tour of the parts of the app that do not change (`src/app/components/Onboarding.jsx` the card, ring, state and
`startTour()`; `src/app/components/onboarding-steps.jsx` the `STEPS` content; store `tour: null | {step}`).
- Starts on the first start (`settings.onboarded` not true), never in the background window (§7i), hidden during smoke. Settings >
  General > "Show the tour" saves Settings as Save does, closes it and starts the tour at step 1. Done, Skip tour (first step only)
  and the X ("Close tour") end it and save `onboarded: true`.
- A non-modal card above the islands and below dialogs: it never takes the focus or a key and its buttons keep the editor's
  selection, so the app can be used while it is open. Header: step title, "n / N", X. Footer: the step's own buttons on the left,
  "Show me" when the step names a page (`view`: editor | plan | flows) other than the one shown (`showPage`), Back / Skip tour and
  Next / Done on the right.
- Spotlight: when the step's `target` (CSS selector) is on screen, a primary-colour ring marks it and the card sits next to it with
  a small arrow, both following the target every frame. Sidebar target: card right of the sidebar; target at the main column's left
  edge: to the right; at the window's right edge: to the left (both centred on its height); else lower half: above, upper half:
  below. Clamped 8 px inside the window, between the title bar and the status bar, 12 px above the toolbar island and clear of the
  rail / push-to-talk / sidebar-button column (except next to the sidebar). No arrow when the card cannot sit level with the
  target. No target on screen: top centre of the page area, 12 px below its top.
- Steps (copy through `keyLabel` / `withKey`, so a rebind shows): Welcome · Settings (the sidebar gear) · Whiteboards, Smart canvas,
  Flowcharts (the toolbar's Insert buttons; Flowcharts explains Synced and freezing with Unlink) · Prefabs (the Flowcharts tab) ·
  Plans (the Plans tab; Backlog, Board and Gantt) · Quick tools and tool search (Ctrl+Tab, Ctrl+Space as chips; both follow the
  current mode) · Dictation (the mic island; Install dictation... = `openInstall()`, next step once installed; Skip; "Dictation is
  installed." once it is) · Assistant (the chat island; Set up assistant... = Settings at Assistant; Skip; "The assistant is
  ready." once usable) · Your threads (Find my threads; Log in..., replaced by "Logged in as <name>"; Find my threads, disabled
  until logged in and while searching) · Ready to write.

---------------------------------------------------------------------------------------------------
## 7h. Dictation (push to talk)

Local Whisper dictation (whisper.cpp; nothing leaves the computer). Files: `src/dictation-main.js` (main), `src/app/dictation/`
(`core.mjs` pure helpers, Node-tested in `test/dictation-core.test.mjs`; `dictation.js` capture, loop and state; `Dictation.jsx`
island, pane and install dialog, mounted once in App.jsx's main column area), the Dictation section of `SettingsDialog.jsx`.
- Settings: `settings.dictation = {installed, model, language, micId, serverPath, modelPath, serverUrl}`; key missing = not
  installed, model `small`, language `en`, micId '' (system default), paths ''. `model`: `small` (Small, default, 465 MB) |
  `large-v3-turbo-q5_0` (Best quality, 547 MB) | `base` (141 MB), the multilingual (not `.en`) `ggml-<model>.bin` of Hugging Face
  `ggerganov/whisper.cpp`, so Automatic works (a stored model, e.g. from an earlier install, is kept). `language`: `auto` or a
  whisper code.
- PTT island: like the sidebar button's island (card, border, shadow), at the bottom-left of the main column directly above the
  sidebar button with a 0.5 rem gap, in every view. In a workspace (§7g), whose content starts at the left (Board columns, Backlog
  rows and footer), it sits at the bottom-right instead (1 rem from the right, 0.75 rem from the bottom: clear of the 10 px
  scrollbars), compact (no padding, 1.5 rem buttons, the transcript button to the left of the mic) and translucent (card at 70 %
  opacity, 2 px backdrop blur), so it covers no workspace content. It holds the mic button (Tooltip "Hold to
  dictate", red tint while recording) and, while the pane is minimized, the transcript button above it (MessageSquareText, "Show
  transcript"), which restores the pane. The mic button never moves: when Minimize's close sequence ends, the island's top edge
  grows upward from the mic button to fit the transcript button (height, 190 ms, ease-out; in a workspace its left edge, width)
  and the icon fades in over the growth's last 100 ms; on restore the icon fades out (100 ms) and the island shrinks back into
  the mic button (190 ms, ease-in), the transcript button removed when the pane is open. A view change meanwhile shows the step's
  end state at once. Neither takes the focus from the editor. Hovering the mic button starts the local server.
  Holding it records (pointer captured: a release anywhere ends it; holding Space / Enter on it works too); not installed: the
  install dialog instead. Tooltip "Hold to dictate (Ctrl+Shift+D)": holding Ctrl+Shift+D (window capture, not while a dialog
  is open) records the same way from anywhere, into the pane; releasing D, Ctrl or Shift, or the window losing the focus, ends it.
- Pane: centred in the page's viewport (§7g; in the editor on the toolbar island's centre, in the library editor on the board's
  view right of the shape panel, following its collapse and width), its bottom 8 px above the toolbar island (no toolbar: the last
  such offset above the viewport's bottom), growing upward: the lowest item of the bottom column (§7c Notices); width 85 % of the toolbar island's (no toolbar: 74 % of the viewport),
  at least the pod's; height at most 25 % of the viewport, the text scrolling inside (themed scrollbar), scrolled to its end when text arrives. A card at
  85 % opacity with backdrop blur; text centred, `text-sm`, selectable; the partial (uncommitted) text dimmer. The pod, a 24 × 2.5 rem
  pill in card colour, sits centred on the card's top edge: Minimize at the left, the live waveform (28 level bars from the mic,
  newest at the right) while recording or a mic-off icon after release in the centre, "Dismiss" at the right. A press shows the
  pod alone at once (showing has no motion); the card grows out under it as text arrives (height transition
  300 ms; the card's bottom stays put, so the pod rises). The §7c notice stack rests 8 px above the shown pane (the pod alone
  included) in the same column and follows its top in every frame; minimized, the pane leaves the column's flow (hidden, inert),
  so the stack rests 8 px above the island.
- After release the pane stays until the app closes or Dismiss is held 3 s: meanwhile the button fills left to right, an earlier
  release resets it. Then the close sequence plays and the transcript is cleared. Minimize plays the same sequence, then the
  transcript button appears; the pane is hidden and inert while minimized. With nothing in the pane (no transcript or error,
  not recording) Minimize closes it like Dismiss, and a minimized pane shows the transcript button only once it has text (a
  transcript landing after Minimize grows the island then). The close sequence (Web Animations, ease-in-out;
  `CLOSE_STEPS` in `dictation.js`, `CLOSE_MS` 740 ms in all): the card narrows from both sides to the pod's width, its text
  fading out first and clipped, not reflowed (220 ms); its height falls to its least (its top padding and borders) while its
  bottom stays 8 px above the island, so the pod comes down with its top, and it fades out behind the pod at the end (180 ms);
  the pod, now just above the island (its bottom 10 px above it), narrows to a circle there, its controls fading (180 ms); the
  circle fades out while shrinking to 0.8 (160 ms) as the pane gives up its place in the column (its top margin falls to minus
  its height and the gap), so the stack comes down over the fading circle to 8 px above the island, where it stays when the
  pane hides. The pod takes no pointer meanwhile. Without text (the card hidden) only the pod's two steps play (340 ms), just
  above the island. A press during the sequence cancels it: the pane shows at once in its normal state. Restoring a minimized
  pane (the transcript button) plays the sequence in reverse (`opening`, same steps and length, each mirrored in time): the
  circle fades in just above the island while growing from 0.8 (the stack rising over it to 8 px above it), widens into the
  pod while its controls fade in, the card grows upward from the island at the pod's width, lifting the pod and the stack,
  then widens to full width while its text fades in; the pod takes no pointer meanwhile. A press
  during it shows the pane at once; Minimize or Dismiss during it starts the close sequence from the full pane. With
  `prefers-reduced-motion` the pane hides and restores at once and the island changes size at once.
- Transcript: in memory (`state.dictation`): kept across draft and thread switches and the workspaces, not across restarts. A new
  press starts a new session that overwrites it and restores a minimized pane. `pttDown(sink)` (the §7i chat panel's mic) runs the
  same recorder and loop, but the session's `{recording, committed, partial, error}` goes to `sink` on every change instead of
  `state.dictation`, so the pane is left as it is; the last call has `done: true`, once, whatever ended the session (the final
  pass, an error, not installed, released before the mic opened, a newer session). The pane's box takes the pointer only on the pod
  and the shown card: beside the pod, clicks reach the page.
- Loop: `getUserMedia` (the stored `micId`, exact; failing that or '' the system default), an `AudioContext` at 16 kHz, a
  ScriptProcessorNode collecting PCM, an AnalyserNode for the waveform. While held, every 700 ms (given 250 ms of new audio and no
  request in flight) the open tail (audio after the last commit) goes as a 16-bit mono WAV to `api.dictation.transcribe`; its text
  replaces the partial text. A pause of 600 ms after sound commits the audio up to the pause's middle (its text is appended to the
  committed text); 20 s without a pause commits at the quietest 30 ms of the last 4 s. A tail with under 150 ms of sound is not
  sent; a commit of such audio is skipped (the open tail just moves past it). Release stops the mic; a final pass commits the
  rest (if it fails, the last partial text is kept as committed). Non-speech tags ("[BLANK_AUDIO]", a lone "(music)") are dropped.
  Mic and server errors show in the pane (destructive colour).
- Main: files in `userData/dictation/`: `bin/` (the extracted `whisper-bin-x64.zip`; `whisper-server.exe` anywhere under it),
  `ggml-<model>.bin`, `ggml-silero-v5.1.2.bin` (Silero VAD, Hugging Face `ggml-org/whisper-vad`). App start (`warmAtStart`, 2 s
  after the main window's `ready-to-show`; not in smoke mode) starts the server in the background when the exe and model exist
  and no `serverUrl` is set; a failure is only logged (console), never shown. Otherwise the first `warm` / `transcribe` starts it.
  Starting spawns `whisper-server -m <model> --host 127.0.0.1 --port <free port> -t <cores - 1, 1…8> [--vad -vm <vad>]` (hidden,
  below-normal CPU priority), waits for `/health` 200 (at most 3 min) and keeps it; a changed exe / model restarts it, an exit
  lets the next request start it again, `will-quit` kills it. Idle it uses about 0 CPU and no GPU, only RAM (Small: about
  0.6 GB working set, 1.1 GB committed; whisper.cpp has no idle or unload option), so it is not stopped when idle, on battery or
  on suspend. `transcribe` POSTs multipart `file`, `response_format=json`, `temperature=0`, `language` to `/inference`
  and returns `text`. Escape hatches: `serverPath` / `modelPath` replace the downloaded exe / model (one that is not found is
  listed in `missing` as "<path> (not found)", and install fails with that message); `serverUrl` (http/https) is used
  as it is, nothing is started (tests point it at a stub server).
- Permissions: the main window's session keeps granting what it granted before, except `media`: audio only, file:// pages only.
- Install (only on request: a press while not installed, or Settings > Install…): a dialog with what is downloaded and from where
  (GitHub ggml-org/whisper.cpp release file `whisper-bin-x64.zip`, about 9 MB; the model and the VAD model from Hugging Face; all
  MIT), the model (radio list with sizes, the stored model preselected (Small by default, listed first as "the default"), each
  model's pros and cons: Best quality more accurate but bigger and slower on the CPU, Base smallest and fastest but more mistakes;
  and the reminder that Small suits most computers: Best quality only for fewer mistakes when space and speed allow, Base only if
  storage or speed requires it), the language (English preselected unless set; Automatic with the wrong-language
  warning), then "Download and install (N MB)". Main downloads only what is missing: the binary from the newest GitHub release
  that has the asset (the vX.Y.Z releases have none, the nightly bNNNN ones do), checked against the asset's `digest` when given and
  extracted with `%SystemRoot%\System32\tar.exe -xf`; the models from `huggingface.co/<repo>/resolve/main/<file>`, checked against
  the sha256 that the Hugging Face tree API lists (`lfs.oid`) when it answers. Each download goes to `<file>.part`, renamed when
  complete; `dictation.progress` events `{step, steps, label, received, total}` drive a progress bar; an error shows with Retry;
  Cancel or closing aborts. Success saves `settings.dictation` `{installed: true, model, language}` and toasts "Dictation is
  ready: hold the mic button and speak."
- Settings > Dictation (after Tags): Status ("Using the server at …" / "Installed" / "Not installed: <missing>" with Install…),
  Model (select, "not downloaded" marked; a missing model downloads through Install…), Downloaded (each downloaded
  `ggml-<model>.bin` with its label, file name and size on disk, "In use" on the stored model unless `modelPath` / `serverUrl`
  replaces it, and Delete; "None" when there is none), Language (Automatic, then the 100 whisper
  languages each in its own name, English first), Microphone (System default, then the input devices; a stored device that is gone
  shows and acts as System default), and under "Advanced: use an existing whisper.cpp": Server program, Model file, Server URL
  (http(s) only; quotes around a pasted path are dropped).
- Delete a downloaded model: a confirmation ("Delete the <label> model (<size>)?", Cancel / "Delete model"). For the model in use
  it asks which other downloaded model to switch to (radio list; the dialog's Model preselected when it is one, else the first),
  or, none left, says that dictation turns off. Confirmed: the switch is saved to `settings.dictation` at once (`model: <other>`,
  or `installed: false`) and laid on the Settings dialog's copy, then `deleteModel(id)` runs and the list and status refresh; an
  error shows under the list. Main: `listModels()` lists the downloaded files of the three model ids (size from the file);
  `deleteModel(id)` accepts only those three ids (a path or any other name is refused, so nothing but `userData/dictation/
  ggml-<model>.bin` is ever deleted) and is refused while an install runs; a whisper-server running on that file is killed and
  awaited (at most 5 s) before the file is removed, then started again on the settings' model (no model left: nothing starts).

---------------------------------------------------------------------------------------------------
## 7i. Assistant (chat panel)

**DeepSeek (2026-10-08):** a second cloud provider (the user: "lets try with deepseek-flash"). `settings.assistant.provider`
`google` | `deepseek` (Qwen Cloud the default since, below), Settings > Assistant > Provider ("Google AI (Gemini)" / "DeepSeek") with that provider's API key
and Model (`deepseekKey`, `deepseekModel`, default `deepseek-flash`; both keys left out of `settings.get`). DeepSeek runs at
`https://api.deepseek.com/v1` (OpenAI format; images in user messages, checked live 2026-10-08), the request carries `model`,
`tools`, `max_tokens` 8192 and `thinking: {type: 'enabled' | 'disabled'}` (enabled only when the turn thinks, with
`reasoning_effort` low | medium | high, xhigh and max as high); `done` reports `n_ctx` 1,000,000. It shares the cloud models'
prompt family `gemini` (prompts.mjs `familyOf`) and so the loosened loop. `status()` adds `providerLabel`. The eval runner takes
`DAF_EVAL_PROVIDER=deepseek` with `DEEPSEEK_API_KEY`.

**Writing rules (2026-10-08, plan §13.13 for the cloud models):** the user's plain output rules apply to the assistant's replies
and to the text it writes. The system prompt ends with `STYLE_RULE` (prompts.mjs, every family, also without tools): keyboard
characters only, no contrast frames, no groups of three for rhythm or three short sentences in a row, no stacked intensifiers,
no filler openers or hedges, one bad and one good example each. `style-lint.mjs` (pure, test/style-lint.test.mjs): `fix` makes
the mechanical changes (a dash between words becomes a comma, `–` in a number range `-`, a dash bullet `- `, curly quotes
straight, `…` `...`, odd spaces plain); `lint` finds what it cannot change (other symbols beyond ASCII such as arrows, bullets
and emoji, `£` and `€` allowed, letters of any script kept; the patterns; the triplet rules only in texts of 8 words or more, and
"A, B and C" lists never). Code spans and blocks are never touched, nor a match found in the user's own text (their message and
the open draft). loop.js fixes every reply in place; a final reply with a lint issue is asked again once (`styleAsk`, the reply
replaced), the second answer kept as fixed. The arguments of a write (any command not a read) have every prose string fixed
(`styleArgs`; keys that hold ids, paths, URLs, colours and the like left alone); with a lint issue the call does not run the
first time per tool in a turn, and the tool message asks for the text again. The cloud APIs take no character grammar
(§13.13 (a)), and the Settings list of rules and banned phrases (§13.13 (b)) is not built.

**Qwen Cloud (2026-10-08):** the default provider (the user: "allow adding models from qwencloud, we can use it's free tier ...
default to qwen3.7-plus, allow user to select models enabled from a checklist in settings"). `provider` `qwen` | `google` |
`deepseek`; a settings file without one means `qwen`. Settings > Assistant with Qwen Cloud: the API key (`qwenKey`, left out of
`settings.get`), a checklist of the chat models in `src/assistant/qwen-models.json` (`{id, label, ctx}`; the image models
qwen-image-3.0 and wan2.7-image-pro and the WebSocket-only qwen3.5-omni-plus-realtime left out) plus any model added by id
(`qwenModels`, default qwen3.7-plus, qwen3.7-flash, qwen3.8-flash and qwen3.8-max; at least one kept on save), and a line telling
the user to turn on Free quota only per model on the Free Tier page (home.qwencloud.com/benefits) so calls stop instead of
billing once a model's free quota (its own, 90 days) runs out. The chat panel header's model name is a menu while there is more
than one choice (`modelChoices`): the enabled Qwen Cloud models, then Gemini and DeepSeek when their keys are set; picking one
saves `provider` and its model field (`qwenModel`, default qwen3.7-plus) at once and refreshes the status. Qwen Cloud runs at
`https://maas.qwencloudapi.com/compatible-mode/v1` (docs.qwencloud.com, read 2026-10-08): `parallel_tool_calls: true` (its
default is one call per reply), `enable_thinking` (true only when the turn thinks) with `thinking_budget` 1,024 / 4,096 / 8,192 /
16,384 / 32,768 for Low to Max, `n_ctx` from the model's `ctx` (1,000,000 for a model added by id). Within a turn loop.js sends
each reply's `reasoning_content` back with its tool calls (the function-calling page: accuracy drops without it). A 403
`AllocationQuota.FreeTierOnly` reads "The free quota of this model is used up. Pick another model in the chat panel." The eval
runner takes `DAF_EVAL_PROVIDER=qwen` with `DASHSCOPE_API_KEY`. Not used yet: the built-in tools (web_search, web_extractor,
code_interpreter, image search; Responses API only, except `enable_search` and PDF file parts on Chat Completions).

**Board coordinates in thousandths (2026-10-08):** Qwen3.8-Flash (Qwen Cloud) gives every box on a picture in coordinates of
0 to 1000 per axis of the picture it looked at, whatever the prompt asks. A probe on a 1454 x 730 whiteboard: asked for pixels,
every box came back scaled by 1000/1454 x 1000/730 (IoU 0 with the target; the marks landed up-left and too small); asked for
0..1000, IoU 0.95 to 0.99 on maps and plain shapes. Its "mid area" box was about half the size of the user's own. So
`board.items.add` and `board.items.update` take `coords: px | thousandths` (default px, §8): with `thousandths` the app turns x and
w into board px by the target's width / 1000 and y and h by its height / 1000, rounded to whole px, also a connector's free ends
and waypoints (`board.mjs fromThousandths`, before the style defaults and the checks, so validation sees px). The target's size is
the one `view.render` draws: a whiteboard's drawn width x its height, a canvas block's artboard, a canvas item's `aw` x `ah`; a
canvas item's `aw`, `ah` and own items and label offsets stay px. With provider `qwen` loop.js passes `thousandths` to
`systemPrompt`, which puts `THOUSANDTHS_RULE` in place of the board pixels line of the cloud prompt: give x, y, w and h in
thousandths of the board with coords "thousandths" (the numbers of a bounding box on the board's picture, which shows the whole
board: x = x1, y = y1, w = x2 - x1, h = y2 - y1); board_get, board_find and the legend answer in board pixels, so never copy
them into such a call; new marks take the size and style of the user's marks on the other maps. Gemini and DeepSeek keep board px.

**Google AI only since 2026-10-07** (the user: "i plan to abandon local llm usage, just stick to google api now. comment out all
the code for local llm stuff"). The assistant runs Gemini through Google AI's OpenAI-compatible endpoint (`settings.assistant`
`googleKey`, `googleModel`, default `gemini-3.8-flash`; Settings > Assistant shows the API key, Model, Status, Permissions and Chat
panel rows). The local llama.cpp runtime described in this section (downloads and the install dialog, `llama-server`, the model
choice and MTP, the degrade steps, sleep, idle unload, warm-up and power events, the local model rows in Settings, the server's
status lines in the panel) is **commented out, not deleted**: `src/assistant-main.js` keeps the whole module as it was in a comment
at its end, and `src/assistant/runtime.js`, `test/assistant-runtime.test.mjs`, `Chat.jsx`, `assistant.js` and `SettingsDialog.jsx`
have their local parts commented out in place, each marked "LOCAL LLM". The `assistant.install`, `assistant.delete` and
`assistant.deleteLeftover` channels answer "Local models are turned off. The assistant uses Google AI."; `assistant.warm`,
`assistant.stop` and `assistant.cancel` do nothing. An OpenAI-compatible server in `serverUrl` (+ `apiKey`) is still used while
`provider` is not `google` (the eval's stub server); the Settings dialog saves `provider: 'google'`. `status()` is `{ready (a key),
provider, ctx, url, missing: [], server: {state: 'ready'}, model}`. The eval runner's local mode stops with a message. Where the text
below describes the local runtime, it describes the commented-out code.

A local chat assistant (docs/plans/agent-automation.md §13): Qwen3.5-9B (or the opt-in Defiant Fable 9B or Gemma 4 12B, Settings > Assistant >
Model) on llama.cpp's `llama-server`, on this computer only.
Files: `src/assistant-main.js` (main, `api.assistant`, §4), `src/assistant/runtime.js` (pure: backend, launch line, health wait,
stream parser), `src/app/assistant/` (`assistant.js` renderer state and client; `loop.js` the tool loop; `prompts.mjs` the system prompt per model
family, pure; `Chat.jsx` chat button, panel and install dialog,
mounted once in App.jsx's main column area after the dictation chrome; `chat-input.js` the text box; `attach.mjs` attachments,
pure, Node-tested in `test/assistant-attach.test.mjs`, and `capture.js`, which reads the selection for them, renders their
pictures and gathers the situation note; `marks.mjs` the numbered marks on those pictures (wave 2 of the reliability plan; the
geometry pure, Node-tested in `test/assistant-marks.test.mjs`); `context.mjs` what the model gets from earlier turns (tool-call summaries, the claim
and promise checks, the compaction trigger) and the turn guards (the situation note, the repeat key, the cycle check, the
repetition detector, the sparse form of a long tool answer, the in-turn trimming), pure, Node-tested in
`test/assistant-context.test.mjs`; `panel.mjs` the
panel's placement, Node-tested in `test/assistant-panel.test.mjs`), the Assistant and Local AI agents sections of `SettingsDialog.jsx`. The model acts on the app
through registry commands (§8) in the tool loop below; their OpenAI tool schemas come from `src/app/commands/tools-schema.mjs`.
- Chat button: a square island mirroring the PTT island (§7h) at the bottom-right of the main column: in the editor `right-2
  bottom-[calc(3.75rem+2px)]`, card, border, shadow, `p-1`, one ghost `icon-sm` button (MessageSquare; Bot while a reply runs),
  so its right inset equals the PTT island's left inset, its bottom edge is level with it, and the toolbar island stays centred
  between the two. In a workspace (§7g) it sits directly above the bottom-right PTT island with a 0.5 rem gap (`right-4
  bottom-[calc(2.75rem+2px)]`), compact (`icon-xs`, no padding) and translucent (card at 70 %, 2 px blur). Tooltip "Assistant
  (Ctrl+Shift+A)", `aria-expanded`, `aria-controls`; it never takes the focus. It toggles the panel.
- Panel: floats over the page in the main column's area (`absolute`, z 20: below the toolbar, rail, PTT island, transcript pane
  and notices), positioned in the page's viewport (`viewportRect()`), so `[data-viewport]` never changes size. Surface as the quick
  menu: `rounded-island border bg-card/70 backdrop-blur-[2px] shadow-xl text-sm`. Default place (`settings.assistant.panel`
  null): right edges aligned with the chat button, bottom 8 px above it (above the toolbar row; in a workspace above the button
  that sits over the PTT island), 26 × 36 rem (338 × 468 px at the 13 px root).
  The user moves it by dragging its header row or its empty chrome (never message text, the text box or a button) and resizes it
  from any corner (within 10 px of one the cursor becomes `nwse-resize` / `nesw-resize`; the opposite corner stays fixed; no handle
  is drawn); it stays inside the viewport with a 0.5 rem margin (the chat button's inset, 6.5 px at the 13 px root), at least 18 × 20 rem. When a drag or resize ends it anchors to the
  nearer horizontal and vertical viewport edges (a tie: right, bottom) and saves `panel` `{x, dx, y, dy, w, h}` (CSS px). On a
  window resize, a size change of the area or of `[data-viewport]` (ResizeObserver) and a view change the anchored gaps and the
  size are kept; when it no longer fits, the size shrinks toward the minimum,
  then the gaps toward the margin (a smaller viewport: filled minus the margin), without changing the stored values. Settings >
  Assistant > "Reset chat panel position" sets `panel` back to null at once.
- Inside: a header row ("Assistant", a status dot, then the running model's name in muted small text, cut with an ellipsis when the panel is narrow (user decision 2026-10-06: `status.model.label`, a custom file's name, or an external server's model file from its /props `model_path`, else its host; the status dot: green ready, amber loading or asleep, red error, grey not running or not
  installed; when the permission mode is not Standard a small muted outline badge "Read only" or "Ask first", tooltip
  "Permissions. Change them in Settings.", whose click opens Settings scrolled to the Assistant section (`openSettings('assistant')`);
  New chat; the Thinking menu; Close), the messages (scrolling, kept at the end while text streams unless the user scrolled up;
  the user's as `bg-secondary` bubbles on the right (its attachments as a row above its text, an image as its thumbnail), the
  assistant's as selectable Markdown on the left (2026-10-07, `Markdown.jsx`: marked's lexer, installed with @tiptap/markdown,
  rendered as React elements, never as an HTML string; headings, lists, task lists, quotes, tables, inline code, links opening in
  the browser, and code blocks with their language and a Copy button, no syntax colours; raw HTML shows as text) with a blinking
  caret while it streams, errors in destructive colour, a reply's reasoning as a native `<details>` "Reasoning" collapsed above its text;
  the tool loop's step lines, below), a status line while the server loads ("Loading the model…") or
  wakes ("Waking…"), or its error with Retry (`warm()`), the tray, and the input row: the mic button, Attach an image (ImagePlus),
  the text box, the context ring and Send (Stop while a reply streams). The tray (2026-10-07, `data-chat-tray`), a row above the
  input row while the message has attachments: the selection's attachment (autoPill, first), tool search's, and the user's images,
  an image as a 48 px tall thumbnail with a round X on its corner, any other as its pill with an X inside; X removes it (the
  selection's stays away for that selection). Images come from Attach an image (a file picker, several at once), a paste into the
  text box or a drop on the panel, at most 6 a message; each is drawn on white at most 1,568 px on its long side as a JPEG for the
  model (`chat-input.js` imageAttachment: label "Image N", numbered through the chat, its body naming the file and size, `picture()`
  as a board attachment's) and a small thumbnail for the tray and the bubble. The tray is kept while the panel is closed; Send sends
  the tray's attachments first, then the text, and empties both; New chat empties the tray. The text box (`chat-input.js`) is a
  small TipTap editor (paragraphs, line breaks and the dictation waveform; attachment pills only in text kept from before the tray;
  no marks), styled as the old Textarea: 1 to 4 lines, growing, then scrolling; placeholder "Message the
  assistant"; `data-chat-input`; its content kept while the panel is closed. Enter (or Ctrl+Enter) sends, Shift+Enter is a new
  line; Send is disabled while the box and the tray are empty or dictation runs; Escape in the panel closes it and the focus returns to the editor;
  Ctrl+Shift+A (window capture, not while a dialog is open) toggles it from anywhere. Opening focuses the text box, refreshes the
  status and, when usable, calls `warm()` (starts or wakes the server); a click outside does not close it; closing keeps a
  running reply and the conversation.
- Mic button (ghost `icon-sm`, Mic icon, tooltip "Hold to dictate", label "Hold to dictate into the message", red tint while
  recording): hold to talk exactly as the PTT button (§7h: pointer captured, Space / Enter, hovering warms whisper, not installed
  opens the dictation install dialog). It runs `pttDown(sink)`. While held, a live waveform (12 level bars from `level()`, newest on
  the right) sits inline in the text box at the caret, in place of selected text, as typed text would; no partial text is shown.
  On release the box is read-only and the mic and Send disabled, the waveform flat and pulsing, until the sink's `done`: the final
  text then replaces the waveform at the same spot (a space added before and after it where the neighbouring text has none, the
  caret after it, one undo step that replaces the selection as typing would) and the box unlocks; nothing said, an error or a
  cancel removes the waveform (the selected text comes back) and unlocks it. The focus stays where it was while held (a Space /
  Enter hold keeps its keyup) and goes to the text box at the end; closing the panel while held releases it and drops the waveform.
  The transcript pane stays as it is (closed), and nothing is sent. Holding it also wakes the assistant (`wake()`, as opening the
  panel does). A mic or transcription error shows in a line above the input row until the next press.
- Not installed (or downloaded but turned off): the body says "Everything you send stays on this computer.", with
  "Install… (N GB)" (or "Turn on…") opening the install dialog. With Google AI and no key: "What you send, attachments and
  pictures included, goes to Google AI.", "Add your Google AI API key in Settings." and Open Settings; that first line is also the
  empty chat's line with Google AI. Usable = `status.ready` and (`installed` or a `serverUrl`).
- Thinking menu (user decision 2026-10-06, the list 2026-10-07): the header's brain button (the same icon, tooltip "Thinking")
  opens a menu of Auto "Thinks for solve, derive or prove requests", Low "Up to 1,024 tokens of thinking", Medium "Up to 4,096
  tokens of thinking", High "Up to 8,192 tokens, less in a long chat", Xhigh "Up to 16,384 tokens, less in a long chat" and Max
  "Up to 32,768 tokens, less in a long chat" (each line muted under its label), the current one checked. With Google AI the lines
  read "Low, or medium for solve, derive or prove requests", "Gemini thinking level low", "... medium", "... high", and "Gemini
  thinking level high, its highest" for Xhigh and Max. A choice is saved at once in `settings.assistant.thinking` (default Auto),
  so it holds for every chat and after a restart; the brain looks pressed at every choice but Auto. Closing the menu puts the focus back in the text box; Esc closes the menu only. The budget
  goes with each request (Requests, below), so a change never restarts the server.
- Chat: `send(parts, note?)` adds the user's message and runs one turn of the tool loop (`loop.js` `runTurn`). `parts` is the text
  box's content (the tray's attachments, then the text); the message keeps them (its bubble shows them above its text)
  and `content`, what the model gets in place of the text (Attachments, below). Each completion streams
  into a new assistant message: `api.assistant.chat({rid: crypto.randomUUID(), messages: [system prompt, …the history
  (Context, below; no reasoning), …this turn's tool calls and full results], tools?, think, used})` (`used`: the last request's tokens without its reasoning, `state.assistant.usage.next`); `think` follows the Thinking menu: Auto
  only for a maths-style request (`solve|derive|prove|verify|calculate|compute|integral|equation|simplify`, automation plan
  §13.16), every other effort always. Events
  by `rid`: delta → text, reasoning → reasoning, tool_call → collected, done / error end it; a completion that only calls a tool
  shows no message. Stop ends the turn: it aborts the turn's AbortController (`state.assistant.turn = {ctrl}`), which calls
  `cancelChat(rid)` on the streaming completion (its text so far stays) and cancels a command waiting in the queue or on its card.
  The conversation lives in memory (`state.assistant`) for the session, never on disk: no setting, localStorage key or file
  holds it, so a reload or a restart starts empty.
- Context (`context.mjs`; user requests 2026-10-06): each request's history starts after the last compaction divider (its
  summary first, as a user note "This is a summary of our earlier conversation." and the summary) and holds at most the last
  20 user turns: the user's texts (earlier ones with each attachment as its pill label "[label]"; the message being answered
  with its attachment bodies, `content`), the assistant's finished texts, and each earlier tool call as an assistant
  `tool_calls` + `tool` pair of summaries kept on its step line (`step.call`, `step.line`): the tool name; the arguments with
  values up to 40 characters (longer strings cut with "...", longer arrays and objects dropped) within 80 characters, always a
  JSON object; and one result line of at most 160 characters, "read: <shape>", "done (draft "<title>"): <shape>" (the title of
  the draft the call names) or "failed (<code>): <message>", where the shape gives numbers, strings up to 40 characters and
  sizes ("3 items", "content (2200 characters)"), never the content. Only the turn in progress carries full tool results;
  when its reply ends they shrink to these summaries. Within the turn (wave 2b of the reliability plan, user decision
  2026-10-07, `context.mjs turnMessages`): each request sends only the turn's last two tool results in full (`KEEP_RESULTS`), the
  older ones of the turn as their step line's result line (the summary a later turn gets), and only the turn's last picture
  message (`view_render`'s, the picture after a write) with its image; an older one keeps its caption text part and loses its
  `image_url` part. The user's own message with its attachment pictures is not touched. The loop's `messages` keep the full
  results; the trimming is applied to each request's copy, keyed by the tool message itself (a server may give every call the
  same id). The repeat and cycle guards work on the call keys as before, except that a repeated call whose result went down to
  its summary runs again instead of getting the repeat note.
  - Claim check: a text-only reply that claims an action (`claims`: `CLAIM_RE` on the reply up to the first line ending in
    ":", since a rewrite or quote follows it; "I" / "I've" / "I have" starting a line or a sentence, also after a comma, +
    opened, changed, added, deleted, removed, created, updated, inserted, replaced, renamed, moved, edited, saved, formatted or
    tagged; "has been" + one of them, not after "Nothing"; a line starting "Done") while no change or navigation (a command whose risk is not `read`) succeeded in
    the turn is asked again once with "No tool call in this turn did what your reply says. Make the tool call now, or say
    plainly that you have not done it."; the first reply is blanked and only the next one shows. At most once a turn.
  - Promise check (plan assistant-reliability.md wave 1, 2026-10-06): a text-only reply that promises an action (`promises`:
    `PROMISE_RE` on the reply up to the first line ending in ":", quoted text left out; "I'll", "I will", "Let me", "I'm going to"
    or "I can do that" starting a line or a sentence, also after a comma, but not when followed by know, explain, summarise,
    clarify, describe or walk: "Let me explain" answers a question) while tools are offered and no change or navigation
    succeeded in the turn is asked again once with "Do it now with a tool call, or say what stops you."; the first reply is
    blanked as for the claim check. At most once a turn, apart from the claim check's own ask.
  - Context ring: a 16 px circular gauge in a 32 px slot between the text box and Send (`data-context-ring`, `role="img"`):
    fill = the last shown request's prompt + completion tokens over the server's context; muted foreground, `amber-500` from
    70 %, destructive from 90 %; tooltip and label "9,920 / 16,384 tokens". The tokens come from the stream (`done.usage`:
    the usage chunk of `stream_options.include_usage`, else the last chunk's `timings` prompt_n + cache_n and predicted_n),
    the context window from `status().ctx` (2026-10-07, so it is right before the first request and after a provider switch:
    the local server's `-c`, 32,768 on a GPU with 10 GB or more else 16,384, runtime.js `contextFor`; an external server's `/props`
    n_ctx; a Google model's `inputTokenLimit` from `GET v1beta/models/<model>`, asked once per model and key, 1,048,576 when it
    does not answer), else `done.n_ctx` (the same numbers per request; compaction at 80 % reads it), else 16,384. It goes back to 0
    on New chat and after a compaction.
  - Compaction: a send when the last usage is at or above 80 % of the context first adds a divider "Summarizing earlier
    messages..." (with a spinner) before the new message, then makes one quiet request (no message, no tools, no thinking):
    a system line, the history before the divider, and "Summarize our conversation so far in at most 300 words of plain
    text. Keep my goals, the decisions, the open items and the drafts we touched, with their titles." The divider then reads
    "Earlier messages were summarized." and holds the summary; the messages above it stay, dimmed (opacity 50 %), and are
    not sent. A failed summary (an error or no text) moves the divider before the last two earlier user turns ("The summary
    failed, so only the last two turns before this one are sent."), which are sent as they are; Stop during it removes the
    divider and the turn does not run.
  - New chat (header button, MessageSquarePlus, tooltip "New chat", while the assistant is usable): stops a running reply (a
    command waiting on its AgentAsk card is cancelled with it) and clears the messages, the waiting attachments (`pending`)
    and the pills in the text box (its typed text stays), the ring, and the session's last read rev and described tools.
- Attachments (`attach.mjs`, `capture.js`): what was selected when tool search opened (§7c) or when the chat box gained the focus
  (Selection pill, below), as `{kind, label, body, picture?, marked?}`. Board items are listed one line each (`itemLines`),
  starting with the id so the model can act without a read, then what the item is and, since wave 2 of the reliability plan (the
  eval's move-valve case: the model moved Valve without knowing where Pump's edges were), its box in whole px, added after the
  120-character cut of the line so long labels never hide it: `k3j9x0a shape rect "Decision" at 420,40 size 160x80`, `t1 text
  "..." at 40,30 width 240` (a text without a measured height), `a1b2c3d image at 0,0 size 320x200`, `v1 canvas with 3 items at
  0,10 size 400x225`, `s1 pen stroke at ...`; a connector keeps its ends, route and bends instead, `c81hd0q connector "yes" from
  k3j9x0a "Decision" (bottom) to q2m1f8z "End" (top), ortho, 2 bends` (since 2026-10-07 each end on an item names the side its
  anchor sits on, `attach.mjs endSide`: n top, s bottom, e right, w left, ne top right, nw top left, se bottom right, sw bottom
  left, c centre, another fraction the box side it is on, no anchor "nearest side"; an end on no item is "(a point at 120,40)", an
  unlabelled one "id (a diam, bottom)"; an end's label is cut at 40 characters and the ends go after the line's cut, so the sides
  always show; the user saw every eval run fail straighten-yes because no model could tell where the yes arrow's ends sat; the
  route ortho when none is stored; the bends, its waypoint count, worded as `board.get`'s brief names them, wave 1c: ", ortho, 2
  bends", ", ortho, no bends", or ", straight" for a straight one without bends, also after the cut). In an attachment the lines
  are in the legend form (wave 2): numbered 1, 2, ... in order instead of "- ", the numbers of the marks on its picture (Vision),
  e.g. `1 v1x6m9q shape rect "Valve" at 420,40 size 160x80`. A long list keeps its first whole lines and ends with "... and N
  more" (`listBody`, within the 2 000-character cap; a flowchart canvas's Mermaid goes first). The items selected on the canvas
  being edited or the active board: label "N items", first line "N selected items on <where>" (the whiteboard or canvas at block
  [p], the library flowchart), then the selected items' lines, numbered first, then "Other items on the board" and the board's
  other items in board order (`boardOrder`), since its picture is the whole board. Else, in the editor view, a node-selected block (`blockKind`): "Flowchart canvas" (first line
  "Flowchart canvas at block [p] of the draft, synced with the library flowchart "<title>", with N items", then its item lines,
  then "As Mermaid" and its Mermaid text, `toGraph` + `toMermaid`, only when the whole body still fits the 2 000-character cap), "Smart
  canvas" and "Whiteboard" (the item list), "Image" (size and source: a pasted PNG and its size, or the URL), "Plan chart" (the
  plan's title, the view, the ticket count and the count per column; frozen copies say so), another block its type; or a text
  selection (`doc.selection`, §8; table cells: their text): "Selection: N lines" (more than one line) or "Selection: N words",
  body the block path and offsets, the text and up to 40 characters around it. A caret alone attaches nothing. Each body is cut
  at 2 000 characters ("... (cut)"). The pill (an inline atom, `PILL_CLASS`) shows the label; in the text box it behaves like a
  word: the caret passes it in one step, Backspace after it and Delete before it remove it, undo brings it back, it can sit
  between words, copy and paste keep it (its data in `data-pill`), as plain text it is "[label]". The message layout (wave 1c of
  the reliability plan, `modelContent` and `context.mjs withNote`; before it the pill label was glued to the words, "[Flowchart
  canvas]Straighten the yes arrow.", with the request in the middle): the situation note (with its playbooks), each attachment
  as a block "Attachment [label]" and its body, the pictures' captions and pictures (Vision), the note (tool search), then
  "Request: " and the user's words last (spaces and tabs collapsed): a pill among them stays as "[label]" ("Request: Make
  [Whiteboard] bigger", wave 2; wave 1c dropped every pill, so "it" lost its object), and the pills before the first word (the
  auto-attached selection) are left out, since the note's "Selected: ... It is attached as [label]." line links them; a message
  of pills only keeps their labels; the parts separated by blank lines. The
  chat still shows the pills inline. Only the message being answered goes with this content, earlier ones with their pill labels
  (Context).
  - Selection pill (user decision 2026-10-06, `chat-input.js` `autoPill`, wired in `Chat.jsx`): when the text box gains the
    focus (a click, Tab, or opening the panel) while something is selected (text, a block such as a smart canvas, flowchart
    canvas, plan chart, image or whiteboard, or board items; `captureSelection`, read at the pointer-down for a click, since the
    board a click leaves stops being the active one), its pill goes at the start of the box (`data.auto`, not an undo step). It
    follows the selection until the message is sent: a selection change made outside the box (the draft's `selectionUpdate`,
    the active board's or the edited canvas's change events) replaces it, and a selection that goes (a caret alone) removes
    it. A pill the user removes (Backspace, Delete, a cut) is not added again for the same selection; another selection clears
    that. Sending or New chat releases it (the next focus attaches the selection again); an auto pill kept while the panel was
    closed is adopted when it opens.
  - Vision (user decision 2026-10-06; the marks wave 2 of the reliability plan): a canvas, flowchart canvas, image (all `canvas`
    nodes) or whiteboard attachment, and a selection of board items (wave 2), carries `picture()`, which renders the board with
    the export rasterizer (`marks.mjs boardPicture` over `rasterizeWhiteboard`, as `src/export.js`: a canvas at its artboard size
    `w` x `h`, a synced canvas from its library board, a whiteboard at its drawn width, a selection's board at `Board.size()`; the
    theme from settings; a `transparent` background drawn as `post`, since llama.cpp drops the alpha channel) at a scale of at
    most 2 and at most 1 280 px on the long side, as a PNG data URL. Every picture but an image's (`marked`) carries numbered
    marks, drawn on the PNG after rasterizing (`drawMarks`: the blob through `createImageBitmap` onto an `OffscreenCanvas`,
    re-encoded as PNG): a badge 22 px high at the picture's own scale (a filled #d6336c circle with a 2 px white ring and a white
    bold number, 13 px; three digits 11 px in a pill), numbered 1, 2, ... in the order of the attachment's legend lines (a
    selection: the selected items first), placed (`markSpots`, `markCentres`, pure) inside a box's top-left corner (its radius and
    2 px in; a turned shape: its bounding box's) and on a connector's routed path (`resolveConnectors`'s geo, `polylinePoint` at
    0.5): at the midpoint, or, when a middle label covers it, just past the label along the path (the label's estimated half
    width, 0.6 of its font size a character and 4 px, plus 14 px), so "yes" stays readable beside its number. `send` renders
    the pictures of the message (after a compaction, before the turn) and its `content` becomes OpenAI content parts in the
    message layout's order: the attachment blocks, then per picture a caption "The next picture shows [label], <size>." (the
    size line since wave 2b, `marks.mjs sizeText`: the picture's own px and the board's, "1280 x 384 of a 1000 x 300 board", an
    image block's "... of a 800 x 450 image", so the model knows the scale while the legend keeps board px; a marked one
    adds " The numbers on it are the legend's.") and `{type: 'image_url', image_url: {url}}` (llama-server reads it with
    `--mmproj`), then the "Request: " text; neighbouring text parts are joined with a blank line (the situation note joins the
    first one), since the Qwen3.5 and Gemma 4 templates glue text parts together and Gemma's trims each. A picture that fails to
    render is left out; the message's `parts` keep no renderer. Only the message being answered carries pictures; the history
    sends its text (the pill label). Plan charts send text only. The picture's tokens (about 1 to 1.5 K at 1 280 px) count in
    the request's usage, so the context ring shows them after the reply. Main reads `/props` before a request with pictures:
    when `modalities.vision` is false (a server without a projector) it drops the image parts, cuts the caption that ended the
    text part before each, its size line included (wave 2; before, that whole text part went, and with it the situation note and the attachment blocks
    it was joined with) and leaves out the tool loop's picture messages (a text part and a picture, Tool loop), so a
    `view_render` call leaves its legend alone; it sends `novision`, and the panel toasts once a session "This server has no
    image projector, so the pictures were not sent."
- Situation note (user decision 2026-10-06, `capture.js` `situation`, `context.mjs` `situationNote`): every turn opens the
  message being answered with a note the app builds (no tool call), rebuilt before each request of the turn so a navigation in
  it shows (the server's prompt cache holds while the note stays the same), never stored (later turns send that message
  without it): "[Situation note from the app. It is current for this message.]", "Page:"
  Editor | Plans (with `plan "<title>"`) | Flowcharts (with `flowchart "<title>"`), "Open draft:" its title and tag ("(behind
  this page)" on a workspace; none), "Thread:" its title (else its URL; none), "Working in the background on:" the quoted titles
  of the drafts that have a background session, comma-separated (only while one exists: Background drafts below), "Selected:" the selection's first body line (a
  text selection with its text; board items: the first line, a colon and the selected items' lines without their numbers joined with "; ", e.g. "1 selected item
  on the whiteboard at block [4]: g3n7c1f shape rect "Gearbox" at 40,40 size 160x80", cut at 140 characters) and "It is attached as [label]." when
  the message has that attachment (else nothing; a message that attaches board items has them as its selection even when the
  chat box's focus ended the board's active state, wave 1c, so the line no longer says "nothing" there), on the
  editor page "Canvas being edited:" `the canvas at block [p]` or none, then "Drafts in this thread (N)" (no thread: "Drafts
  (N)", all drafts) in sidebar order, one line each with its title (cut at 50 characters) and tag, at most 30 ("N, the first
  30 in sidebar order"), the permission line (Tool loop), then, when the message gets playbooks (Playbooks below), "How to do
  this:" and each playbook's title line with its id ("Open a draft (playbook open-draft)", wave 2b) and its text, and "[End of situation note]"; a blank line, then the rest of the message
  layout (Attachments). About 100 to
  300 tokens, up to about 750 with two playbooks; on a message with pictures it is the first text part. The system prompt adds
  "The situation note is current. Earlier replies may be out of date because the user can change things between messages.
  Check it before acting."
- Playbooks (wave 1b of the reliability plan, 2026-10-06, `src/app/assistant/playbooks.mjs`, pure): short procedures like the
  SKILL.md files of coding agents, for the requests where the eval showed the first call going wrong. Each is `{id, title,
  triggers, when: {kinds?, views?, permission?}, text}` (wave 2b, after the skill index of Figma's MCP: `triggers`, the phrases
  that select it, were `when.words`; the model never sees them): a "Before: ..." first line where a step must come first
  (change-board-item: close Canvas Mode when that canvas is being edited; delete-board-item: add `board_items_remove` with
  `commands_describe`; tag-draft: add `drafts_setTag` and `tags_list`), numbered steps with example calls (valid arguments,
  test), what not to do, and a last "Check: ..." line, what a fail looks like (a board change: "the item in the result and on the
  picture after your change is as the request asked. If not, say what differs."), at most about 300 tokens (1 050 characters,
  test), keyboard characters only. The tool text of `board_items_add`, `batch` and `canvas_edit` names its playbook
  ("Playbook: change-board-item.", "edit-draft-text", "canvas-mode"; `define.mjs guide.playbook`, §8 Tool schemas), and
  `commands.index {q}` finds a playbook by its id's words. The set: change-board-item ("Change or add an item on a board": the id from the attachment, whose numbered lines match the marks on its picture, wave 2, or
  `board_find {path, q}`, then `board_items_straighten {path, id}` to straighten an arrow (2026-10-07: it also turns both ends
  to face each other), else `board_items_update {path, id, patch}`; to add, `board_items_add`
  with only the new items placed by the attachment's boxes, wave 2b, with the triggers add, draw and around; never `canvas_edit`), delete-board-item (`board_items_remove {path, ids}` once, the ids from
  the attachment or `board_find`, the user confirms on the card), move-board-item (wave 2: both ids from the attachment's numbered lines, then
  `board_items_place {path, id, relation, of}`, which works out x and y; `board_items_update` with x and y for any other place), rename-board-item (`patch.html`, a connector's `labels.mid`; top left = the smallest x and y),
  open-draft (`drafts_list`, then `drafts_open` with the id, never a title; wave 2b: "When one title matches, open it without
  asking. Ask which one only when several match.", after the eval's "Shall I open that one?" with one match), tag-draft (`commands_describe ['drafts_setTag',
  'tags_list']` when needed, `tags_list`, the draft id from `drafts_list`, `drafts_setTag`), edit-draft-text (`doc_get` outline,
  then `doc_replace` / `doc_insert` by path), picture-question (answer from the attached picture, no tool, boxes as
  `[{label, bbox_2d}]` JSON), read-only (say plainly that the assistant is in Read only mode and cannot change anything, what it
  would do and that Settings turns it off; no tool for the change, no `commands_index` search), canvas-mode (only to draw or
  edit by hand) and situation-question (wave 1c, `permission` 'any': a question about the page, the open draft, the thread, the
  flowchart or plan, or what is selected is answered from the situation note with no tool call, a tool read only for what a
  draft or board says inside; its words are pairs of a question word, what / what's / which / where, and page, draft, drafts,
  thread, flowchart, plan, selected, selection or open, so "What flowchart is open?" gets it and "Rename Pump" does not; it
  says to call no tool, so it never comes with a change playbook). `pickPlaybooks({text, parts, view, permission})` (`text`: the message's strings; `parts`: its attachment kinds;
  `view`: the turn's tool-set key) scores each matched word or phrase 3 a word (`triggers` entries are a word, an adjacent phrase
  such as "left of", or a list of words that must all occur, such as open + draft), a matching attachment kind 2 and the view 1;
  a playbook needs a matched word, and, when the message has attachments and the playbook lists kinds, one of those kinds (else
  one of its kinds or views when it lists any); `permission` 'readonly' = only in Read only mode, 'any' = always, none = not in
  Read only mode. At most 2 ("hello" gets none), the second only with at least half the first one's score and only when both
  or neither change things (picture-question and read-only, which say to call no tool, never come with a change playbook), and
  canvas-mode never with another (wave 2b review: "Let me draw" also matches change-board-item's draw, which forbids
  `canvas_edit`). picture-question's triggers also have which and "what would", so the eval's "Which shape is widest?" and "What
  would you change about this flowchart?" get it, not a change. `capture.js
  situation(parts, viewKey)` adds them to the note (the loop passes `session.viewKey`, so they stay the same within a turn);
  `commands.index {q}` returns the others whose id, title or triggers hold every word of `q` (§8 Catalogue).
- Gemini profile (2026-10-07; the user, after Gemini read the draft over and over for a general question, invented draft ids and
  worked blind: "since we are using bigger models now we can loosen up the guidelines and let the models decide to tools or
  whatnot. loosen up the guardrails. also context right, the first thing the models should do when asked to do things is to gain
  context of the draft it is working on, or the referred draft to work in, such that it wont hallucinate"). With Google AI
  (`familyOf` → `gemini`): its own lean prompt (prompts.mjs GEMINI: answer general questions from knowledge, know a draft before
  changing it, read another draft first with its draftId, choose tools freely, do the whole request and check visual work with
  view_render, infer a vague request from the existing work, never make up an id); the situation note adds the open draft's id,
  every listed draft's id and the open draft's outline ("[3] paragraph: the first 100 characters... (N characters)", a board as
  "[6] whiteboard, 7 items, 989 high", at most 120 blocks; capture.js outlineLines) and drops the playbooks; the tools are the
  editor, board and drafts sets together in any view with a draft open; every tool result and picture of the turn stays in full
  (no trimming); 40 calls; no re-asks for tool text, claims or promises (an empty reply is still asked once), no stop for a
  repeated write or a circle, a repeated read runs again, no read-after-write end. For every family a turn stops only when the
  same call fails with the same error twice in a row. `view.render` of a board is headless (drawn from the board's data, so a
  covered or hidden window no longer blinds it); the whole-view capture needs `window.visible`. Board pictures are drawn 1:1 up to
  `PICTURE_SIDE` 1,600 px (marks.mjs), so a picture's pixels are board pixels. Thinking on Auto stays `low` (each simple command is
  two round trips of about 1.5 to 2 s). Several calls in one Gemini reply (parallel function calling) all run, in order, in that
  round trip: the assistant message carries every call, each tool message follows, and the pictures (view_render's, the one after
  a board change) go after the last tool message; the small models keep one call per request. runtime.js `accumulate` splits calls
  by id: a new id at a taken index (Google AI streams parallel calls whole, each at index 0) is a call of its own.
- Tool loop (`src/app/assistant/loop.js`; automation plan §13.1, §13.2 Tool calls, §11 Q18): a turn without thinking first reads
  `ui.state` for its view key (`src/app/commands/tool-sets.mjs` `viewOf`: the page when it is not the editor, `plan` | `flows`; no
  open draft → `none`; mode `text` → `editor`; mode `board` | `canvas-edit` → `board`, and so does mode `text` with a canvas,
  flowchart canvas, image or whiteboard block node-selected, ui.state's gate `node.board`, wave 1b: a node-selected flowchart
  canvas got the editor set without `board_find` before; and so does a message that attaches board items, `boardItems`, wave
  1c: once the chat box has the focus the whiteboard is no longer the active board, whiteboard.js `updateActive`, so the mode is
  text again and the eval's delete-selected got the editor set), then `app.capabilities {available: true}`,
  and offers in the model form of the model's family (§8 Tool schemas) the core `ui.state, drafts.list, drafts.open, batch, commands.index,
  commands.describe` plus that view's set whose gates hold now: editor `doc.get, doc.find, doc.selection, doc.insert, doc.replace,
  doc.delete, doc.format, board.list, canvas.edit, view.render`; board `board.list, board.get, board.find, board.items.add,
  board.items.update, board.items.place, board.items.straighten, board.items.remove, board.fit, ui.select, canvas.edit, canvas.close,
  view.render` (`view.render` and `board.items.place` wave 2, `board.items.straighten` and `board.fit` 2026-10-07); none `drafts.create, drafts.get, drafts.setTag, drafts.delete, threads.list, tags.list, folders.list`; plan
  `drafts.get, drafts.setTag, tags.list`; flows nothing more. It adds the tools described earlier in the session
  (`session.described`, a Map name → tool, kept across turns while `session.viewKey` stays, cleared when it changes). Thinking
  requests carry the same tools (thinking never removes them). A successful `commands_describe` call puts the returned tools into this turn's tool list (the next
  request carries them) and into `session.described` (at most 8 000 characters, oldest dropped first), and the model gets `{added,
  risk, unknown?, notAdded?}` back instead of the schemas. `history.undo` / `history.redo` are never offered, not even through
  describe (the model must not undo the user's own typing; each step line has its own Undo), nor `tool.run` (its palette Undo /
  Redo entries would do the same); `board.render` is in no set (its
  PNG would reach the model as base64 text; `view.render`'s picture goes as a user message, below). Only the offered tools run: a call to any other command, or a `batch` step outside
  them (a step id may be a tool name or a command id), answers `unknown_command` "<name> is not one of your tools
  (commands_describe adds it)" and nothing runs. The system prompt is the model family's (`prompts.mjs` `systemPrompt(family,
  {tools, uiControl})`, wave 1c, after OpenCode's one prompt file per model family chosen by the model id; `familyOf(settings.assistant.model)`:
  `gemma12b` → gemma, everything else, also a custom model file or an external server, → qwen, the same split as main's
  sampling; plain keyboard characters, short literal sentences): the opening sentence and the situation note rule (Situation
  note), then, when the request offers tools, on new lines the family's rules, while `view_render` is offered (the editor and board sets, wave 2) "When a
  target is visual or ambiguous, call view_render and use the numbers on the picture." (both families), and, with on-screen
  controls on, "Use ui_snapshot and ui_invoke only when no other tool does the job." (application control, section 8 Catalogue, in no view set and added with
  `commands_describe`). Qwen (a numbered procedure since wave 1 of the reliability plan, 2026-10-06): "Follow these steps." 1
  read the situation note and any attachment before acting, follow its How to do this steps when it has them (wave 1b), and
  never say you cannot see something before reading it; 2 on a board, find the item first (`board_find` by its label, or
  `board_get`) and act on its id; 3 in the draft, read the block paths (`doc_get` format outline or `doc_selection`) and act on
  them, paths refer to the last read, after a stale error read again; 4 one tool call at a time, wait for its result; 5 "After a
  write that succeeded, reply to the user in one short sentence. Read again only when the user asked for more changes." (wave
  1c; "after a write or a stale error, read once to check" before); 6 when the target is ambiguous, ask one short question; 7
  greetings and general questions need no tools; 8 an action needs a tool call in this reply, never a claim, and nothing is said
  done unless a tool result in this turn shows it; 9 no tool names or ids to the user, blocks and drafts named by their text and
  titles; 10 `commands_index` lists more tools by category, `commands_describe` adds the tools named. Then: to open a draft,
  `drafts_list` for its id, then `drafts_open`, and when several drafts match, ask which one first; deletions are confirmed on
  the card in the app (never asked in text); for several changes, add the tools needed, read the paths, then run one `batch`.
  Gemma (wave 1c, from the eval: a right first call, then reads and unasked changes up to the call cap, and tool names made up
  for a question the note answered): shorter imperative steps, "Steps:" 1 read the situation note first, it names the page,
  the open draft, its thread, the open flowchart and what is selected, and questions about these are answered from it with no
  tool call; 2 follow How to do this; 3 ids and paths from the attachment or the note, a read only when they are not there; 4
  one call at a time, only the tools it has, and `commands_index` lists more when none fits; 5 only what the user asked, nothing else added, moved, changed or deleted; 6 "When
  the request is done, reply in one sentence and make no more calls."; 7 a failed call fixed from the error once, or the user
  told; 8 nothing said done unless a tool result shows it; 9 greetings and general questions need no tools; 10 no tool names or
  ids to the user; then the open-draft and deletion-card sentences; no read after a write. Each tool call (one per request, `parallel_tool_calls: false`; extra calls are dropped) has its name mapped back to the
  command id (`commandIdOf`, a catalogue lookup) and its arguments parsed (not JSON: an `invalid_args` answer, nothing runs), then
  runs as `invoke({id, args, source: 'agent:assistant', ifRev, signal})`, `ifRev` = the `rev` of the assistant's last document
  read (a `doc` read, or a read whose result carries `rev`; kept across turns), so its paths map over edits made since. The call
  goes back as `{role: 'assistant', content, tool_calls: [that call]}` and `{role: 'tool', tool_call_id, content: <the answer as
  JSON, at most about 8 000 characters (`MAX_RESULT`, 16 000 before wave 1; `clipResult`): sparse answers (wave 2b, after
  Figma's `get_design_context`, which flags a response sparse and names the child ids; before, a `cut` note): a `board_get` or
  `board_find` answer, or a `doc_get` JSON read or outline, that is longer keeps its first whole items, blocks or entries (never
  JSON cut mid-way) and adds `sparse: true`, `next` (the ids of the items, or the paths of the blocks or outline entries, left
  out; after a `board_find` answer's own `next`, §8; ids that do not all fit keep the first ones and `more` counts the rest) and a
  one-line `hint`: "Read one with board_find {"path":[p],"itemPath":[…],"q":"<the first id left out>"}." or "Read one with
  doc_get {"path":[k]}." (a first block too long to show: "Block [k] is too long to show. Read its text with doc_get
  {"path":[k],"format":"text"}."); the tool text of `board_get` and `doc_get` says so (§8 Tool schemas); other text is cut with "... (cut. Call doc_get with
  {"format":"outline"} for the block paths, then read one block with {"path":[n]}.)" (for doc_get; with a path, its inner
  blocks by path) or "... (cut. Do not repeat this call. Read a smaller part, such as one block by its path.)">, then (wave 1c,
  every tool answer of the turn, also the repeat note and after the circle note) " Calls left in this reply: N." with N = 8
  (`MAX_CALLS`) less the calls run so far, this one included}`. Pictures (wave 2): a tool answer with a picture (`view.render`:
  its `url` beside `picture: 'next message'`, also as a batch step's result; `context.mjs takePictures`) goes without the `url`,
  so the tool message holds the legend and the sizes (`width`, `height` and the size line `size`, wave 2b), and right after it the loop appends a user message `[{type: 'text', text:
  'Picture from <tool> of <the board at block [p] | the view>, <size>. The numbers on it are the legend\'s.'}, {type: 'image_url',
  image_url: {url}}]` (`pictureMessage`; OpenAI-style servers take images in user messages only; the size line, wave 2b, e.g.
  "1280 x 568 of a 900 x 400 board", lets the model ask for one board sharper); its step line says "Rendered
  the board" or "Rendered the view". After the turn's first successful `board.*` change (one a turn; not in Read only; off when
  `settings.assistant.pictureAfterWrite` is false, Settings > Assistant) the loop renders that board (`view.render {path,
  itemPath?}` with the write's path, or `board.insert`'s new block) and appends after the change's tool message, so it goes with
  the next request, which rule 5 makes the reply, a user message with "The board after your change, <size>. Check it against the
  request, then reply.", view.render's legend on the next lines (board px), and the picture (about 1 K tokens; decision 3 of the plan).
  Only the turn's last picture message keeps its image (Context, in-turn trimming).
  Neither picture reaches later turns (the history is built from the chat's messages, where the call is a step line's summary);
  the ring counts them through the server's usage. Repeat
  guard (`callKey`: the tool name and its arguments with sorted keys): the second identical call of a turn is not run (no step
  line) and gets the tool answer "You already called this with the same arguments; use that result." while that result is one
  of the last two sent in full (wave 2b, `fullResults`; else it runs again and counts as a first call); for a read that holds
  for every later repeat too, so a repeated read never ends the turn (user decision 2026-10-07: the stop kept halting promising
  work); for a write the third identical call ends the turn with "Stopped a repeated call."; a successful change (a command whose risk is not `read`) or a `stale` failure of one clears
  the count, so a read after a write or a stale error runs. Cycle guard (user request 2026-10-06, `context.mjs` `loopKind` over
  the turn's call keys in order, run before a call that the repeat guard lets through): `cycle` when the last 4 or 6 keys are a
  run of 2 or 3 calls made twice (A B A B, A B C A B C; not one call four times), `hammer` when the tool of the last call was
  called with 5 or more different arguments since the last successful change (`HAMMER_NOTE`; 4 before wave 1b, which caught
  five legitimate `doc_get` block reads), `stop` at 8 or more (`HAMMER_STOP`). The first time either is caught, the call runs and
  its tool answer gets, after a blank line, "You are going round in circles (calls: <the tools>). Say what you have learned and
  what is missing, then make a different call or ask the user."; after that a cycle, or `stop` at any time, means the call is
  not run and the turn ends with "Stopped: the assistant kept repeating itself." (the 6th and 7th arguments of a hammered tool
  run without a second note). A write that succeeds each time (so the repeat count clears) followed by the
  same read is the case the repeat guard misses. Read-after-write guard (wave 1c, `context.mjs` `readsAfterWrite` over the
  turn's calls that ran, `{write, ok}`: a write is a `doc.*` or `board.*` command whose risk is not `read`, `guardWrite`, wave 2;
  the Gemma eval made the right change first
  and then read, listed and added unasked items up to the cap, ending with an empty reply): a successful change followed by 3
  successful reads in a row (`READS_AFTER_WRITE`; a failed call breaks the run, a later change starts it again) ends the turn
  after the third read runs: no further request, and the reply is a plain assistant message (not an error) built from the
  change's step title, `doneReply`: "Done: " and the title in the past tense up to its first colon or "and", without its
  brackets, e.g. "Done: changed one item of a whiteboard or canvas.", "Done: replaced one block of the open draft.". Navigation is
  not a change here (wave 2; it was in wave 1c, so a question about a draft just opened ended with "Done: opened a draft in the
  editor."): `drafts.open`, `canvas.edit`, `canvas.close`, `ui.select`, `ui.scrollTo`, `ui.zoom`, `ui.invoke` and `batch`
  followed by three reads go on to the model's reply. The next request follows in the same turn (later turns get its summary pair, Context above). The permission mode's policy applies (§8 Policy). Standard
  (the agents' policy): writes run, every destructive call (`drafts.delete`, `doc.delete`, …) and every approval call asks on
  the AgentAsk card (a click only; a denial goes back to the model as `denied`), `doc.replace` never asks. Ask first: every
  write, destructive and approval call asks, reads run. Read only: every call that is not a read is refused, and the turn's
  tool list holds reads only. The mode is read at every call, so a change in Settings applies to the next call of a running
  turn. Tools the mode refuses are left out of the tool list (core, view set and described tools alike) and of
  `commands.index` / `commands.describe`; a call to one anyway is answered `denied {reason: policy}` with the mode's message,
  which the step line shows, and nothing runs. With on-screen controls off (`uiControl: false`) `ui.snapshot` and `ui.invoke`
  are left out the same way and the system prompt's sentence about them is dropped. When the mode is not Standard the situation
  note ends with one line before its end marker: "Permission mode: Ask first. The user approves every change on a card." or
  "Permission mode: Read only. You can read and answer. Every change is refused." Each call adds a step line: an icon (check: done; ban: denied; alert: another
  error), the command's title (a `ui.invoke` that ran says what it did instead, such as `Pressed "Bold (Ctrl+B)" (toolbar)`,
  `Typed 12 characters into "Width"` or `Pressed "Delete draft" on "Week 3" (sidebar)`), then the error message or, for a write,
  its result as short JSON; a document command that made
  undo steps has Undo, which runs `history.undo` once (source `ui`: the user's click, so no permission mode applies) while the open draft and its `rev` are as the
  step left them (else a toast "The draft changed after this step: use Ctrl+Z"), then reads "Undone"; a step on a background
  draft (its answer's `draftId` is not the open draft's) has no Undo. A turn ends on a text-only
  reply, Stop, an error, after 20 commands ("Stopped after 20 commands."; 8 until 2026-10-07, when the user found it halted promising work), when the same command fails twice in a row ("Stopped:
  <tool> failed twice (<message>)"), on the third identical call (Repeat guard), on the second cycle (Cycle guard), with "Done:
  ..." after a change and 3 reads (Read-after-write guard) or on a second looping reply (Repetition
  guard: while a reply streams, its content or its reasoning is checked every 30 new characters, `repeats`: its last 60
  characters found 4 times without overlap; the stream is aborted (`cancelChat`) and hidden, and the same request is sent once
  more with thinking off for the rest of the turn; a second loop ends the turn with "The reply started repeating itself and was
  stopped."; a looping compaction summary counts as a failed one); a tool call written into the reply text (`<tool_call>`, `<function=`) is asked again once as
  a real call, a claimed action without a change once more (Context, Claim check), and a promised one once more (Promise
  check). While a turn runs, `state.agent.connections` holds `{name: 'assistant', since, disconnect: stop}` (app.info reports
  it); the status bar leaves that entry out and shows the model in use instead (user decision 2026-10-06: `status.model.label`,
  a custom file's name, or an external server's model file from /props `model_path`, else its host; a click opens Settings > Assistant), and the AgentAsk card shows inside
  the open panel above its input row (§8).
- Background drafts (Tier B of docs/plans/assistant-reliability.md §7, built 2026-10-07, `src/app/assistant/sessions.js`): the
  assistant works on a draft that is not open while the user keeps working in the open one. A command with a `draftId` that names
  another draft (§8 Background drafts) runs in that draft's background session: `sessionFor(draftId)` starts one on first use with
  the draft and its history file from the drafts store, in a hidden editor made by the open draft's factory (`actions.js
  makeEditor`: the same extensions, node views and undo depth) inside its own `.page` host in `#sessions` (App.jsx, an empty
  `aria-hidden` `inert` div in the main column): `position: absolute; left: -20000px; top: 0; visibility: hidden;
  pointer-events: none`, the page's width and typography, never `display: none`, so node views measure and boards draw. A
  session saves 800 ms after a change through the open draft's save path (`actions.js saveOther`: the same save chain, draft
  file and history file, the sidebar entry updated), keeps its own revisions (`rev.js revs`, starting above the open draft's rev
  at that moment) and ends 5 minutes after its last command (`IDLE.ms`, `window.__agent.sessions.idle`, which a harness
  shortens; its last change saved, the editor destroyed, the host removed). The open draft never gets a session, and a session
  never writes the open draft's file. Closing the window saves every session's last change first (`flushSessions`); deleting a
  draft ends its session unsaved (`dropSession`); `drafts.setThread` and `drafts.unpush` on a draft with a session patch its
  draft object too, so its next save keeps them.
  - Handover: when the user opens a draft that has a session (sidebar, `drafts.open`, the plan cards, push of another draft:
    every path goes through `openDraft`), `handOver` waits for the session's command in flight (a batch: the whole batch) and a
    session still starting, saves its last change, and the main editor loads the session's document and undo steps (its log as
    a history file, at least 50 steps kept, also with "keep 0 after closing"), not the disk copy; the session ends and its badge
    goes. Later commands with that `draftId` name the open draft and go to the main editor. A command that was waiting while
    the handover ran answers `stale` ("The user opened that draft meanwhile; read it again"); one that comes while the user's open
    is still loading answers `busy`.
  - Undo: the session's history moves with the document (the history file path of §7e), so Ctrl+Z in the main editor after a
    handover undoes the assistant's background writes one step at a time, newest first.
  - The tool loop sends, as `ifRev`, the rev of the last read of the draft the call names (`session.revs[draftId]` for a
    background draft, `session.lastRev` for the open one); the picture after a board write renders the board of the draft the
    write named. `drafts.open` stays offered; the playbooks do not name `draftId` yet (queued for the open-draft playbook: "when
    the user says to keep working where they are, use draftId instead of opening").
  - UI: while the assistant wrote to a background draft in the running turn (`state.bgWrites`, cleared when the turn ends or
    the draft is handed over), its sidebar row shows a secondary badge with a spinning LoaderCircle and "Assistant" after the
    title (`data-draft-assistant`), and the chat panel shows a status line above the input row, a spinning LoaderCircle and
    `Working on "<title>"` (the draft written last; `data-chat-working`).
  - A background session never starts on the draft the background window has (Computer use, below): `busy` "The background
    window has that draft. Use computer_act with target background, or background_close first."
- Computer use (2026-10-08, the user: "i think computer use is the way to go with visual stuff ... build out the computer use
  stuff, for it to work background tasks, its perhaps good to just have a headless version, then inside the main user's interface
  say that its running headless and can let the user press a button to see the headless tab as a pane in the app"; after
  OpenAI's computer use: the model sees a screenshot and answers with mouse and keyboard actions at pixel positions on it, and
  gets a fresh screenshot after every action). `src/computer-main.js` in main, `src/app/commands/computer.mjs` in the catalogue
  (§8 Catalogue: `computer.act`, `background.open`, `background.close`), offered only to the cloud family (`familyOf` → `gemini`:
  Google AI and DeepSeek) in every view, beside its sets (`tool-sets.mjs COMPUTER`, loop.js `toolList`); the small models' sets
  never hold them, so `MAX_SET` stays theirs. They are in `UI_CONTROL`: with on-screen controls off none is offered or runs.
  - Targets: `main`, the user's window, and `background`, the background window (below). A screenshot is the target's
    `webContents.capturePage()` scaled to at most 1,344 px on its long side (the page's CSS viewport times the window zoom is
    its size in window px, so a minimized window keeps it), as a JPEG data URL (quality 80); main keeps its scale per target,
    and every x and y the model sends is a pixel of the last screenshot of that target (outside it: `invalid_args` "x and y must
    be inside the 1344 x 840 screenshot."; none yet: "Take a screenshot of the main window first."). A minimized main window
    paints nothing new, so `main` is refused while it is minimized ("The main window is minimized. Ask the user to bring it
    back, or work in the background window.").
  - Actions (`webContents.sendInputEvent`): `click` (`button` left, right or middle) and `double_click` (a move, then down and up
    with clickCount 1, then 2), `move`, `drag` (`path` of 2 to 50 points: down at the first with the left button held, moves in
    steps of about 10 px, 8 ms apart, through the rest, up at the last), `type` (one `char` event a character, so it works in the
    editor, a board's text and inputs; a new line is Enter), `key` (`keys` such as `Enter`, `Delete`, `Shift+Tab`, `Control+B`:
    key down with its modifiers, its character for Enter, Space or a single character without Control, Alt or Meta, key up;
    ArrowUp and the like map to Electron's names), `scroll` (a wheel at x, y by `dx`, `dy` screenshot px, positive `dy` down),
    `wait` (`ms` up to 3,000) and `screenshot`. Every action answers with a fresh screenshot of its target once the page
    settles: two animation frames and at least 150 ms (at most 500 ms when the page has no frames). A press (`click`,
    `double_click`, a drag's ends) on the assistant panel, the chat button, the approval card, the pane or under
    `data-agent-deny`, and a `type` or `key` while the keyboard focus is in one of them, is `denied` (as ui.invoke's
    deny list, §8 Application control): the model never answers its own card, changes its own settings or types to itself.
    Undo and redo keys (Control+Z, Control+Y, Control+Shift+Z) on `main` are `refused`: they would undo the user's typing.
  - Policy: `computer.act` is a read (its screenshot), so it is offered in Read only; its input actions check the mode in
    their run as a write (`refusal` of a write: "Read only mode. Change it in Settings."; Ask first: the card "wants to click in
    the main window" and so on, on every action). `background.open` and `background.close` are writes.
  - Pictures: the loop takes the screenshot out of the answer as view_render's (`picture: 'next message'`, context.mjs
    `takePictures`), so the tool message holds `{width, height, size}` with the size line `1344 x 840 screenshot of the main
    window` or `... of the background window, draft "<title>"`, and the picture follows as a user message "Picture from
    computer_act, <size>." (no legend sentence: a screenshot has no marks). Several calls in one reply each add their picture
    after the reply's last tool message (the `later` path). Only the turn's last 3 screenshots keep their image in a request
    (loop.js `SHOTS`; their captions stay), since each request resends every picture it keeps; view_render's pictures are
    unchanged. Step lines: "Looked at the main window", "Clicked in the background window", "Typed 12 characters in the main
    window", "Pressed Enter in ...", "Dragged in ...", "Scrolled the ...", "Opened a draft in the background window", "Closed
    the background window".
  - Prompt: the GEMINI rules add "For visual work on the page, such as drawing by hand, pointing at something in a picture or
    checking how something looks, use computer_act. It answers with a screenshot, and its x and y are pixels of that
    screenshot. To work on another draft this way while the user keeps working in theirs, call background_open, then
    computer_act with target background."
- Background window (Computer use; §4 Sessions/windows): a second copy of the app, offscreen and never shown, that works on one
  draft while the user keeps working in theirs. `background.open {draftId}` ends a background session of that draft first (its
  last change saved, actions.js `openInBackground` → sessions.js `handOver`), then main loads index.html with
  `?worker=1&draft=<id>` in a new background window (another draft there is saved and its window closed first; opens and
  closes run one at a time) and answers when the renderer has set `window.__worker` with that draft open; then a screenshot.
  The draft open in the user's window is refused (`refused` "That draft is open in the main window. Work on it there with
  computer_act and target main."), so two windows never edit one draft.
  - Worker mode (`store.js WORKER`, from the query): the same app and UI, so the model sees what the user would. At start it
    reads settings and drafts, asks nothing of the forum, opens only its draft (`remember: false`), shows the editor page (no
    `lastView`), and sets `window.__worker = {draftId (null: the draft could not be loaded), release()}` (release: board edits
    committed, then `saveNow`). `saveSettings` changes its own copy only, never settings.json; opening another draft or a new
    one toasts "This window works on one draft only."; the title strip sends no window colours. It autosaves its draft through
    the normal save path (800 ms after a change); main lets only that draft's save and history save through (§4).
  - The user's window hears `computer.event` (actions.js `watchWorker`): `worker` sets `state.worker` `{draftId, title}` (null
    when it closes, which also hides the pane), `saved` updates that draft's sidebar entry and the title.
  - Handover: opening the background window's draft in the user's window (`openDraft`, every path) first calls
    `computer.close`: the background window saves (`release`), main destroys it, and the draft then loads from disk with the
    change. Deleting that draft closes the background window the same way before the file goes to the trash.
  - Closing: `background.close`, 5 minutes after its last action (`computer.open` and every action on `background` restart the
    timer) and when the main window closes; each saves first (at most 10 s), then destroys the window. `computer.act` with
    target `background` while none is open: `not_found` "No draft is open in the background window. Call background_open
    first."
- The pane (`src/app/assistant/BackgroundPane.jsx`, mounted by `Assistant` in Chat.jsx): while `state.worker` is set, the chat
  panel shows a status line above the input row (`data-chat-background`): a Bot icon, `Working in the background on "<title>"`
  and an outline `xs` button Show (Hide while the pane is shown; `state.workerPane`). The sidebar row of that draft shows the
  "Assistant" badge (`data-draft-assistant`, without the spinner unless the running turn also wrote to it). Show opens the pane:
  a floating panel (`data-background-pane`, region "Background window") at the top left of the main column (0.5 rem from the
  top, 3.5 rem from the left, clear of the board rail), 30 × 20 rem, card at 90 % with a 2 px blur, resizable from its
  bottom-right corner (CSS `resize`, at least 16 × 10 rem), a header with "Background window", the draft's title in muted small
  text and Hide (X), and the window's live view as an `img` (object-contain; "Waiting for the first picture" before the first
  frame). View only: no input goes through it. While it is shown main sends the offscreen window's `paint` frames (kept as its
  last frame always) at most every 200 ms, the last one of a burst too, as JPEG (quality 70, at most 960 px wide); opening it
  repaints the window so a frame comes at once. Hide, the background window closing or the panel unmounting stops them
  (`computer.pane(false)`).
- Install dialog (only on request): what is downloaded with sizes (`status.missing`), that each file is checked against its
  SHA-256 before it is kept, the sources (llama.cpp from GitHub ggml-org/llama.cpp, MIT; the model and image projector from Hugging
  Face, the chosen model's repo (`status().model.repo`) and its projector's (`status().model.mmprojRepo`), named once when they are
  the same, the chosen model's licence (`status().licence` `{name, model, url}`: Qwen3.5 or Gemma 4, both Apache-2.0) with a link to
  its text, a copy of the licence notice kept in the model folder), the
  graphics backend, then "Download and install (N GB)"; a progress bar from `progress` events; an error with Retry; Cancel aborts.
  Success saves `installed: true`, toasts "Assistant ready" and warms the server.
- Main: pins in one `PINS` object: llama.cpp `b11433` (2026-10-05; contains PR #29773), per backend `cuda` =
  `llama-b11433-bin-win-cuda-12.4-x64.zip` + `cudart-llama-bin-win-cuda-12.4-x64.zip` (656 MB), `vulkan` =
  `llama-b11433-bin-win-vulkan-x64.zip` (33 MB), `cpu` = `llama-b11433-bin-win-cpu-x64.zip` (19 MB); Hugging Face
  `unsloth/Qwen3.5-9B-GGUF` at commit `3885219` (2026-03-02, pinned 2026-10-06; `Qwen3.5-9B-Q4_K_M.gguf` 5,680,522,464 bytes,
  `mmproj-BF16.gguf` 921,705,024 bytes, saved as `Qwen3.5-9B-mmproj-BF16.gguf` because the 4B's projector had the same name), the
  licence from `Qwen/Qwen3.5-9B` at `c202236` (user decision 2026-10-06: 9B at Q4 with a 16 K context, replacing the 4B `Q6_K`).
  `PINS.models` holds one file per `settings.assistant.model`: `qwen9b` (default) the file above; `fable9b` (user decision
  2026-10-06, opt-in) from `DavidAU/Qwen3.5-9B-The-Defiant-Fable-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP-GGUF` at `8b192a8`
  (2026-10-02): `Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-Q4_K_M.gguf` 6,828,993,824 bytes (sha256 `d33db5e5…`), with
  `mtp` its `…-NEO-MAX-MTP-Q4_K_M.gguf` 6,979,975,392 bytes (sha256 `d7eb4fac…`). Fable's `mmproj-BF16.gguf` is Unsloth's file (same
  size and sha256), so both Qwen-based models use the one projector download; its chat template is byte-identical to Qwen3.5-9B's (tools
  and `enable_thinking` unchanged); Apache-2.0, so the licence pin stays. `gemma12b` (opt-in, automation plan §11 Q22; added
  2026-10-06, the stock model since the user decision of 2026-10-07) from `unsloth/gemma-4-12b-it-GGUF` at `fc034cf`:
  `gemma-4-12b-it-Q4_K_M.gguf` 7,121,861,440 bytes (sha256 `0a270ec9…`), saved under its own name; with `mtp` also its MTP head,
  a separate draft file, `mtp-gemma-4-12b-it.gguf` 465,109,248 bytes (sha256 `145db909…`), saved as
  `gemma-4-12B-it-MTP-Q8_0.gguf`; the projector from the same repo, `mmproj-BF16.gguf` 175,115,840 bytes (sha256 `2e269f90…`),
  saved as `gemma-4-12B-mmproj-BF16.gguf`; licence Apache-2.0, and as no Gemma 4 repo has a licence file, the notice kept is the
  base model card, `google/gemma-4-12B-it` `README.md` at `707f0a3` (git blob `99f6f1c`), saved as `gemma-4-12B-it-README.md`.
  The projector and the draft keep the names of the user's own earlier downloads (`as` in the pin), so nothing downloads again.
  `qwen9b` with `mtp` (wave 2b,
  user request 2026-10-07) is `qwen9bMtp`: `unsloth/Qwen3.5-9B-MTP-GGUF` at `9716a63` (2026-05-16), `Qwen3.5-9B-Q4_K_M.gguf`
  5,868,826,976 bytes (sha256 `e8dd9481…`, read from its tree API on 2026-10-07), saved as `Qwen3.5-9B-MTP-Q4_K_M.gguf` (the
  regular file has the same name), its MTP head inside the file as Fable's; it shares the default's projector (the MTP repo's own
  `mmproj-BF16.gguf` differs by 96 bytes) and licence; label "Qwen3.5-9B Q4_K_M MTP". Each model pin names its
  projector and licence (`PINS.models.<id>.mmproj`, `.licence`, Gemma's `.draft`); the install downloads only the chosen model's
  missing files. `auto` backend: NVIDIA (vendor 0x10DE) anywhere → cuda, AMD / Intel → vulkan, else cpu.
- GPU memory: once per start main runs `nvidia-smi --query-gpu=memory.total,memory.free --format=csv,noheader,nounits` (`%SystemRoot%\System32\nvidia-smi.exe`,
  hidden, 3 s timeout; it ships with the NVIDIA driver) and keeps the first GPU's line as `status().gpuMemory` `{total, free}` MiB;
  no answer (no NVIDIA card, an error) → null, treated as 8 GB.
- Install: downloads what is missing, each to `<file>.part` with `progress` events, checked before it is kept: the zips against
  the GitHub release asset `digest` (sha256), the model files against the Hugging Face tree's `lfs.oid` (sha256) at the pinned
  commit, the licence against its git blob id. A missing checksum stops the install with a message; a mismatch deletes the file
  and fails it ("… is damaged (checksum mismatch) and was deleted. Try again."). The zips extract (`%SystemRoot%\System32\tar.exe
  -xf`) into `llama-<build>-<backend>.part/`, renamed when all are in. A `serverPath` / `modelPath` / `mmprojPath` that is not
  found fails the install with that path.
- Server: `llama-server -m <model> --mmproj <mmproj> -ngl 99 -c <32768 on a card with 10 000 MiB or more, else 16384> -fa on -np 1 -b 2048 -ub 512 --cache-reuse 256 --cache-ram 0
  --jinja --no-webui --host 127.0.0.1 --port <free> --api-key <new 32-byte hex per start> --reasoning-budget 4096 --reasoning-budget-message
  "Thinking budget reached. Give your best answer now." [--no-mmproj-offload] [-ot "^output\.weight$=CPU"] [--spec-type draft-mtp
  [-md <draft file>] --spec-draft-n-max 2] [--sleep-idle-seconds <sleepMinutes × 60>]`
  (`-ot`: Defiant Fable only, when the GPU's total memory is under 10,000 MiB or unknown: its 16-bit output matrix goes to the CPU,
  ≈ 8.3 → 6.3 GB on the GPU, slower; anchored because llama.cpp regex-searches tensor names and `output\.weight` alone also
  matches every `blk.N.attn_output.weight`; `--spec-type draft-mtp --spec-draft-n-max 2`: Qwen3.5-9B's (wave 2b) and Fable's MTP files, their own draft heads predicting
  2 tokens, no draft model file; Gemma with MTP adds `-md <gemma-4-12B-it-MTP-Q8_0.gguf>`, its head as a separate draft file)
  (`--no-mmproj-offload`: Qwen3.5-9B and Fable only, when the GPU's total memory is under 10,000 MiB or unknown, the 8 GB
  baseline: the projector and image encoder on the CPU, user decision 2026-10-06: ≈ 1.1–1.4 GB more for the model; only pictures
  are slower; from 10,000 MiB, Fable's `-ot` threshold, the flag is left out and the projector runs on the GPU, wave 2 of the
  reliability plan; Gemma's 175 MB projector stays on the GPU on every card, and Gemma gets no `-ot`) (`--reasoning-budget 4096` is only the default: every thinking request sends its own budget, Requests below, which
  replaces it; the budget message stays the server's) (spawned hidden with an argument array, cwd = its folder, below-normal priority, 4 KB log tail); ready when `/health` is
  200 (503 while loading, at most 3 min). The first load's lines with `model buffer size`, `KV`, `compute buffer size` go to the
  console once. Degrade steps (cumulative to `settings.assistant.step`, the most VRAM for the least speed first): 1
  `--cache-type-k q8_0 --cache-type-v q8_0`, 2 `-ngl 24` (never q4_0; the context stays 16 K); a stored step above 2 runs
  as 2; a load that exits out of memory saves the next step and starts once
  more. A changed exe / model / projector / draft file / step / sleep / model choice / MTP restarts it; an exit after the load sets `stopped` (the next request starts
  it again); `will-quit` kills it. Spawned without `detached`, so Node's Windows job object also ends it with the main process
  on `app.exit`, a crash or a forced kill (process audit 2026-10-06 with stub servers, the same for whisper-server, §7h).
- Warm-up and idle (automation plan §13.2): 10 s after the window shows (after the dictation's warm-up), when installed,
  `warmAtStart`, not on battery and no `serverUrl`, main starts the server quietly (errors to the log). Asleep after `sleepMinutes`
  (llama-server frees the model, KV cache and projector; the next request reloads them); killed `idleUnloadMinutes` after the last
  request (a running chat defers it), on battery, on suspend and after 5 min locked; started again 10 s after mains power, unlock,
  or resume (when the window has focus). Opening the chat panel calls `warm()`.
- Requests: `POST /v1/chat/completions` with `Authorization: Bearer <key>`, `{messages, tools, tool_choice: 'auto',
  parallel_tool_calls: false (with tools only), response_format?, stream: true, stream_options: {include_usage: true},
  chat_template_kwargs: {enable_thinking: !!think}}`
  (Gemma 4's template reads the same switch: `<|think|>` in the system turn when true, an empty thought channel when false) and the
  model family's card preset (runtime.js `SAMPLING.qwen` / `.gemma`, `sampling(think, tools, family)`): Qwen3.5-9B and Fable fast
  `temperature 0.7, top_p 0.8, top_k 20, presence_penalty 1.5, max_tokens 3072`, think `1.0, 0.95, 20, 1.5`; Gemma 4 12B
  `temperature 1.0, top_p 0.95, top_k 64, presence_penalty 1.5` in both modes (fast with `max_tokens 3072`); thinking with `reasoning_budget_tokens` = the Thinking menu's budget (Low 1,024, Auto and Medium 4,096, High 8,192;
  b11433 reads it per request, `tools/server/server-common.cpp`, alias `thinking_budget_tokens`) and `max_tokens` = budget + 2,048
  (runtime.js `thinkingLimits`). The budget is cut to the server's `n_ctx` (`/props`) - `used` - 2,048, never below 0, so the answer
  keeps its 2,048: High at 16 K leaves 6,144 for the prompt, and later in a chat it thinks less. A request that carries tools
  sends `presence_penalty 0` instead (runtime.js `sampling(think, tools)`, wave 1 of the reliability plan): llama.cpp penalises
  the last 64 tokens of the sequence, prompt included, which hold the ids and labels of the tool result or attachment that the
  call must copy; tool-less requests (the compaction summary) keep 1.5. Never `X-Conversation-Id`. A second chat with the same `rid` aborts the first. `done` comes at
  `[DONE]` (or the stream's end, after the usage chunk) with `usage` {prompt, completion} and `n_ctx` (a `/props` read beside
  the request).
- Settings > Assistant (after Dictation): Status ("Using the server at …" / "Installed" / "Downloaded, turned off" / "Not
  installed: <missing>") with Install… (not installed or off), Permissions (user decision 2026-10-06: a select
  "Assistant permissions", `settings.assistant.permission`: Standard (`standard`, default) / Ask first (`ask`) / Read only
  (`readonly`) / Allow all (`all`, 2026-10-07); below it one muted line, "Standard. Makes changes you can undo. Asks before
  deleting, pushing or logging in." / "Ask first. Asks before every change." / "Read only. Reads and answers. Changes nothing." /
  "Allow all. Does everything without asking, deleting included. You still submit posts on the forum yourself."; then a checkbox "Let the assistant
  use on-screen controls" (`uiControl`, default on) with the muted hint "Lets it click and type in the app when no command
  fits."; a checkbox "Show the assistant the board after each change" (`pictureAfterWrite`, wave 2, default on; Tool loop) with
  the muted hint "It checks its work on a picture of the board. Each picture uses about 1,000 tokens."; each change is saved at once, as the model choice, also when the dialog is then cancelled; §8 Policy),
  Model (a select, `settings.assistant.model`: "Qwen3.5-9B"
  (`qwen9b`, default) / "Defiant Fable 9B" (`fable9b`) / "Gemma 4 12B" (`gemma12b`), beside it in muted text "GPU memory <total / 1024, rounded> GB" or "GPU
  memory not detected. Assuming 8 GB." (local only); below it one muted line, "Qwen3.5-9B. Recommended. Works on 8 GB cards." /
  "Defiant Fable 9B. A community fine-tune of Qwen3.5-9B with fewer refusals. Same tools and image support. Needs about 9 GB of
  GPU memory, or runs slower on 8 GB cards." / "Gemma 4 12B. Google's model, strong at tool use and pictures. 7.1 GB, needs about
  10 GB of GPU memory or runs slower with layers on the CPU."; for every model (Qwen3.5-9B since wave 2b) a checkbox "Faster replies
  (MTP)" (`mtp`, default off) with "Predicts two tokens at a time. Uses a 5.9 GB model file in place of the regular one. Turn off if
  replies get slower." (Qwen3.5-9B) / the same with "a 7.0 GB model file" (Fable) / "Predicts two tokens at a time. Adds a 465 MB draft file. Turn off if replies get slower." (Gemma); a change is saved at once (also when the dialog is then cancelled), so
  the status, Install… and the chat follow it, and stops the server, which starts again on the new files when it was running
  and they are here; the other choice's files stay and show under Unused files), Model file (when ready and local, laid out as Dictation's downloaded
  models: the name, "Qwen3.5-9B Q4_K_M", "Qwen3.5-9B Q4_K_M MTP", "Defiant Fable 9B Q4_K_M", "Defiant Fable 9B Q4_K_M MTP", "Gemma 4 12B Q4_K_M" or "Custom model"; the file and size, `status().model`; a badge with its state, Loaded /
  Asleep / Loading… / Not loaded / Failed to load; and Delete when installed: a confirmation, then `delete()` and
  `installed: false`, saved at once and laid on the dialog's copy), Unused files (when `status().leftovers` has any, ready or
  not: each file's name and size with Delete; a confirmation "Delete <file> (<size>)?" / "The assistant no longer uses this file.
  It is removed from this computer.", then `deleteLeftover(file)`; never deleted without that click), Backend (Auto with the backend found / NVIDIA CUDA / Vulkan /
  CPU), Idle unload (minutes, 0–1440, 0 = keep loaded), Chat panel "Reset chat panel position", and under "Advanced: use an
  existing llama.cpp or server": Server program, Model file, Projector file, Server URL (http(s) only, with the note that messages
  and drafts then go to that server; quotes around a pasted path are dropped). Settings > Local AI agents (`data-agent-deny`): a Switch "Allow local AI
  agents (MCP)" (`settings.agent.enabled`) with "Lets MCP clients work in this app. Any program on this computer can connect while
  this is on. Deleting and pushing ask you every time, and the forum is never submitted."; while the switch is on: Port (`settings.agent.port`, 1024-65535,
  default 47823); Status from `agent.status` ("Off", "Listening on port N", "Port N is in use by another program. Pick another
  port.", plus ". Save to apply your changes." while the switch or port differ from the running server); Server URL
  `http://127.0.0.1:<port field>/mcp` (read-only, Copy) "For clients that connect to a URL (Streamable HTTP)."; Stdio config, the
  JSON `{mcpServers: {easywriter: {command, args, env}}}` of `agent.status().stdio` (Copy) "For clients that start the server
  themselves. Paste it into their MCP config.". Saving starts, restarts (a new port) or stops the server (§8 Agents) at once.

---------------------------------------------------------------------------------------------------
## 8. Commands and agents (src/app/commands.js, src/app/commands/*.mjs)

One typed command registry is the only way a program acts on the app (docs/plans/agent-automation.md §3–§7): palette entries
with a `command` field (§7c), the smoke script, the in-app assistant (`source: 'agent:assistant'`) and, later, external agents over
a local pipe (§8 Agents). Raw UI clicks keep calling actions.js and are not audited. Nothing here runs unless something
calls `invoke`.

Files: `src/app/schema.mjs` (the JSON-Schema subset below: `validate(schema, value, $defs)` → `[{path, message, expected}]`,
`withDefaults`, `checkSchema`, `deref`), `src/doc-path.mjs` (paths, below), `src/app/digest.mjs` (`cyrb53`, `argsDigest`),
`src/app/rev.js` (revisions, below), `src/app/commands/define.mjs` (`define(def)`, `fail(code, message, data)`),
`src/app/commands/schema-defs.mjs` (`ID`, `PATH`, `URL`, `TAG_ID`, `CONTENT`, `ITEM`, `ITEM_BRIEF`, `ref(name)`), `src/app/commands/catalogue.mjs`
(`CATALOGUE`, `$defs = {ID, PATH, URL, TAG_ID, ITEM}`, `MODEL_DEFS = {...$defs, ITEM: ITEM_BRIEF}`, `byId(id)`), one module per namespace (`app.mjs`, `ui.mjs`, `settings.mjs` (settings, tags, folders),
`threads.mjs`, `drafts.mjs`, `doc.mjs`, `history.mjs`, `tool.mjs`, `batch.mjs`, `commands.mjs` (tool discovery)), `palette.mjs` (the palette's command ids),
`tools-schema.mjs` (Tool schemas, below), `tool-sets.mjs` (categories, the assistant's tool sets and budgets, pure and import-free), `src/app/commands.js` (the executor) and `src/app/components/AgentAsk.jsx` (the agent request card). Application control
(`ui.snapshot`, `ui.invoke`, Catalogue below) lives in `src/app/assistant/ui-tree.mjs` (pure: deny list, risk rules, paging, refs,
change readback; test/ui-tree.test.mjs) and `src/app/assistant/ui-control.js` (the DOM walk and the dispatched events).
The catalogue modules are pure (node --test imports them, test/commands-contract.test.mjs); what needs the editor, a DOM or
`window.api` reaches a command through `ctx`. `tool.mjs` reaches the palette registry through `bindTools({context, all, failedNeeds,
command})`, which tools.js calls when it loads (tools.js imports JSX, the catalogue may not). Settings writes go through actions.js
`saveSettings` / `changeSettings` (the Settings dialog's apply path: a theme or undo-depth change remounts the editor with its
history), `ui.notice` through `actions.notify`.

Schema subset (`src/app/schema.mjs`): `type` (a name or a list; `integer`, `number` = finite), `properties`, `required`,
`additionalProperties`, `minProperties`, `maxProperties`, `enum`, `const`, `items`, `minItems`, `maxItems`, `minimum`, `maximum`,
`minLength`, `maxLength`, `pattern`, `oneOf`, `anyOf`, `$ref` to `#/$defs/<name>`, `default` (filled into the args before a command
runs), plus the annotations `title`, `description`, `examples`; any other keyword fails `define` at load. Errors stop at the first
failure: `path` is a JSON pointer into the args, `expected` the schema at that pointer with its `$ref` resolved. Messages use
keyboard characters ("must be at least 0", "must be at most 4"). A `$ref` may carry a `description` beside it (`ref(name,
description)` in schema-defs.mjs): validation ignores it, the model form and the teaching message below show it.

**Teaching message** (wave 1 of the reliability plan, `define.mjs` `argsMessage(def, error, $defs, at)`, test/commands-contract):
an `invalid_args` answer from step (3), and a batch step's, says after the validator's line the description of the failing
argument (walking the args schema with `$defs` along the error path; the nearest description up the path when the leaf has
none, a `$ref`'s own description included) and the command's first example: `args/itemPath/0 must match ^[A-Za-z0-9_-]{1,32}$.
itemPath: Only for a canvas item inside a whiteboard, as its id. Omit it for a canvas block. Example: {"path":[4]}` (a batch
step: `steps[2].args/...` and that step's command's example). A union with no description of its own names its alternatives
(wave 1c, `define.mjs unionText`: each branch's description, else "one of a, b" for an enum, its type in words, "with <key>"
for a branch of required keys): `args/threadUrl must match one of 2 forms. threadUrl: Text, or null.`, `args must match one of
3 forms. With marks, or with block, or with presetId.`; `doc.insert`'s and `board.insert`'s `at` say it themselves: "A block
path such as [3], or one of start, end, cursor". `data` stays `{path, message, expected}`.

**Command definition** (`define(def)`, checked when its module loads): `id` matches `/^([a-z]+(\.[a-zA-Z]+)+|batch)$/` and is at
most 48 characters (the MCP tool name is the id with `.` → `_`); `title` (a destructive command's names the object it removes),
`group`; `risk` ∈ `read | write | destructive | approval`; `undo` ∈ `doc` (TipTap history) | `own` (the namespace ships
`<ns>.undo/redo`) | `none`; `headless` (default true; false = needs the user at the window: denied for agents, except the in-app assistant, which gets the
`window.visible` gate instead); `slow` (default
false; true = 300 s timeout); `needs` (default []; gate ids of `src/app/gates.mjs`, or `{gate, if?(args), with?}`); `args` (an
object schema), `result` (schema, informative); `examples` (≥ 1 `{args, dryRun?}`, each validated by the contract test; the first
one is the model's "e.g." and the teaching message's example); `brief` (optional, a string: one sentence on when to use the
command, for the model form of the tools); `notFor` (optional, a string, wave 1b: what a model wrongly reaches for the command
to do, and what to use instead, rendered in the model form as "Not for: <notFor>."); `guide` (optional, wave 1c, after OpenCode's
one structured text per tool: `{before?, args?, errors?}`, short sentences on what to do before calling, the argument rules and
what its errors mean, rendered in the model form as lines "Before: …", "Args: …", "Errors: …"; any other key fails `define`); and
`plan(ctx, args)` → `{tr, result}` (a builder: one ProseMirror transaction built from the editor's current state) and/or
`run(ctx, args)` → result (imperative). Optional: `ask(ctx, args)` → the phrase after "wants to" (or `{title, description}`) for the
agent card, `busy(ctx, args)` → true while the user works on the target. `ctx = {state, editor (the current one), api, actions
(actions.js), board (the canvas being edited, else the active board), plans, flows, source, policy, signal, ask(title, description,
{risk, steps?}) → Promise<boolean>, emit(type, payload), lib}`; `lib` holds the renderer helpers commands need (content
conversion, Markdown, HTML, selection, board busy checks, undo depths, `ui.state`, capabilities, the audit ring).

**Envelope** `invoke({id, args?, source, dryRun?, ifRev?, timeoutMs?})` (`import { invoke, on } from './commands.js'`; an
in-process caller may also pass `signal`, an AbortSignal: aborting it answers `cancelled`). `source` ∈ `ui | palette | smoke |
agent:<name>` (`<name>` = `/^[a-z0-9][a-z0-9_-]{0,31}$/`). Answer: `{ok: true, result, draftId, rev, undoSteps, ms, dryRun, diff?}`
or `{ok: false, error: {code, message, data?}}`; `invoke` never rejects. Codes: `unknown_command, invalid_args (data {path, message,
expected}), precondition_failed (data {failed: [{gate, message, fix}]}), denied (data {reason: policy | headless | user | timeout,
hint?}), cancelled, stale (data {rev}), busy, not_found, already_exists, refused (data {code}: a namespace rule), failed, timeout,
unauthorized, too_large`.

**Executor** (`invoke`, in order): (1) every source but `ui` / `palette` joins one promise chain, so one such command runs at a
time; (2) unknown id → `unknown_command`; (3) args checked against the schema → `invalid_args`, then defaults filled; (4) with
`ifRev`, every argument the schema types as `#/$defs/PATH` is mapped from that revision onto the current doc → `stale` when its
block was deleted or merged, or the revision is unknown; (5) a `draftId` argument that names no draft → `not_found`; every
applicable gate of `needs` on its subject → `precondition_failed` listing every failed gate — before any ask, also on a dry run;
(6) the policy table below (asks through the card); (7) `busy` when the user is mid-gesture or editing text on the target board, or
edits that canvas (after the ask: the user may have started meanwhile); agent writes never end the user's text edit; (8) settings
writes read `state.settings` inside the queue; (9) a builder's transaction is dispatched with `editor.view.dispatch` with
`closeHistory` set on it and an empty `closeHistory` transaction after it (it never merges with the user's typing before or after),
never focusing or scrolling; the selection is mapped, not moved; `undoSteps` = the undo depth after minus before (a doc command
makes at most one; `history.undo` reports −n); a transaction built on a doc that changed meanwhile → `stale`; (10) a dry run
applies the transaction without dispatching and answers `diff = {from, to, before, after}` (`from`/`to` the changed range in the new
doc, `before`/`after` the outline entries of the top-level blocks it touches in the old / new doc); an imperative command's dry run
answers `{simulated: false, title, args}` (a read runs); (11) timeout 60 s (`slow` 300 s; `timeoutMs` capped at 600 s), counted after
the ask → `timeout`; (12) the answer is stamped with `draftId` (the open draft's; a background session's command: that draft's),
`rev` (likewise), `ms`, and every non-`ui` call adds an audit line.

**Revisions** (`src/app/rev.js`, `state.rev`): an integer that only grows — +1 for every transaction that changes the doc (the
editor's `transaction` handler, next to the undo log of §7e) and +1 for every editor mount, which also clears the log. The log keeps
the last 500 changes `{rev, before, maps}`. `mapPath(path, ifRev, doc)`: `ifRev` = the current rev → the path as given; else the
position before the block in the doc as of `ifRev` is mapped through every change since (assoc +1) → the path of the block starting
there, or `'stale'` (deleted, merged, older than the log, newer than the doc, or from before the last mount). A step that
replaces one token at the block with one (`setNodeMarkup`: a board write replaces the atom, a block type change its opening
token) maps with assoc -1, so the block keeps its path (wave 1b: a `board_get` by path after a board write answered `stale`
before, and kept doing so, since a failed read refreshes no rev); a longer same-size replace starting there (a paste over whole
blocks) stays `'stale'`. `(draftId, rev)` is the
version key every answer carries; an agent sends the `rev` of its read as `ifRev`, the rev of a read of the same draft: a background
session keeps revisions of its own (`revs(holder)`, the same log and mapping; `recordRev`, `clearRevLog` and `mapPath` are the open
draft's, on `state.rev`), and `ifRev` with a `draftId` maps against that draft's.

**Background drafts** (Tier B, §7i Background drafts): `doc.*` (`get`, `find`, `selection`, `insert`, `replace`, `delete`, `format`,
`command`), `board.*` (`list`, `get`, `find`, `insert`, `items.add`, `items.update`, `items.place`, `items.straighten`,
`items.remove`, `items.arrange`, `set`, `render`), `view.render` (with a `path`), `flow.insert` and `ui.select` take an optional
`draftId` (`DRAFT_ID` in schema-defs.mjs: `#/$defs/ID`, described "Another draft's id"; each brief ends "draftId: another draft to
work on without opening it (drafts_list gives it); leave it out for the open draft."). The executor routes a command that has a
`draftId` argument and needs `doc.open` or `view.editor` (`routes(def)`): a `draftId` naming another draft than the open one runs it
in that draft's background session (`sessionFor`; none started for the open draft), where `ctx.editor` is the session's editor,
`ctx.state` reads the session's `draft`, `rev` and `editor` over the store state, `ctx.session` is set, `ctx.board` is null, and
`ctx.lib`'s `toNodes`, `toHtml` and `selection` use the session's editor (its schema) while `boardBusy` is false; the answer
carries that draft's id and rev. Without `draftId`, or naming the open draft, a command runs on the main editor as before. The gate
rule: a session satisfies `doc.open` and `view.editor` for its `draftId` (the `ui` subject is `{editor: <the session's>, view:
{type: 'editor'}}`, `node` reads the session's doc), while `board.active` and the Canvas Mode gates stay the open draft's (the gate
table is unchanged). In a background draft `ui.select` moves no focus, scrolls nothing, never node-selects a board block and never
makes a board the active one. A batch works on one draft: its routed steps name the same `draftId` or none (else `invalid_args`), the
steps run in that session with one undo step there, and a step that opens, pushes or deletes that draft is refused (it runs after
the batch). A `draftId` that names no draft → `not_found`; one that cannot be loaded → `not_found`; the draft's open still loading
→ `busy`; the user opened it while the command waited → `stale`.

**Addressing** (`src/doc-path.mjs`): a block is a PATH, the child indices from the doc down to it (`[4]`; `[2, 1, 0]` = list →
second item → its paragraph), `#/$defs/PATH` = 1–16 non-negative integers. `outline(doc, {depth = 1})` → `[{path, type, text,
attrs?}]` (`text` the plain text, cut after 120 characters with "... (cut, N characters in all)" (2026-10-07), child blocks joined by a space, a hard break as `\n`; a board node's
`attrs` = `{kind, items, w, h}`, a heading's `{level}`), `nodeAt(doc, path)`, `find(doc, {text, regex?, caseSensitive?})` →
`[{path, from, to, context}]` over textblocks (at most 500; literal text unless `regex`; case-insensitive unless `caseSensitive`;
`context` = 40 characters each side), `posOfPath(pmDoc, path)` / `pathOfPos(pmDoc, pos)` on ProseMirror docs. Text offsets are
block-local: characters of the textblock, a hard break counting one (ProseMirror's `parentOffset`). Board nodes = `whiteboard`,
`canvas`, `planChart`.

**Content** (`content` of `doc.insert`, `doc.replace`, `drafts.create`; exactly one key): `json` (a block node, an array of them, or a
doc; each checked against the schema), `html` (≤ 4 MB, through TipTap's `generateJSON`, so the schema's rules drop forum-illegal
styling; `<img>` has no node and is dropped), `markdown` (≤ 4 MB, through `@tiptap/markdown`'s `MarkdownManager` over the editor's
extensions; `![…](…)` images are dropped), `images` (1–20 `{dataUrl: data:image/…, w?}`: one canvas per picture at its natural size,
at most 8000 px a side, displayed `w` wide (default: natural), never wider than the page). Dropped constructs are listed once each in
`result.dropped` (e.g. `['img']`). A non-block node or an empty result → `invalid_args` at `/content/<key>`.

**Precise edits**: every command changes one addressable unit (one draft, one block, one entry, one field set) and never rewrites a
whole document, board or list; several changes go in one `batch`. `doc.replace` refuses a board node (`denied {reason: policy,
hint}`: its items change through board commands; swapping a board is `batch [doc.delete, doc.insert]`).

**Gates** (`src/app/gates.mjs`, shared with the UI): the executor reads each gate's subject from the arguments when the command
names its target (`draftId` → that draft `{id, threadUrl, pushedAt}`, `path` → that node `{type, attrs}`) and from the live UI
otherwise (`ui` = the store state, `doc` = `{inTable}`, `history` = `{canUndo, canRedo}` of the open doc, `board` = the live board's
snapshot, `node` = the node-selected block; a command in a background session reads `doc.open`, `view.editor` and `node` from
that session: Background drafts above). Used now: `doc.open` (every `doc.*` and `history.*`), `history.canUndo` /
`history.canRedo` (`history.undo` / `redo`), `draft.pushed` (`drafts.unpush`), `view.editor` (`ui.select`, `ui.scrollTo`, `ui.zoom`,
`canvas.edit`, `canvas.close`), `board.active` (`ui.select` with `ids` and no `path`), `doc.inTable` (`doc.command` row and column
commands), `node.canvas` / `node.whiteboard` (`canvas.edit` with a `path`), `board.canvasMode` (`canvas.close`: Canvas Mode is open,
the live board is of kind canvas); `tool.run` checks the
gates of the entry it runs and reports them. `window.visible` (subject `window` = `{visible}`, true while
`document.visibilityState` is `visible`, so shown and not minimized; message "The window is not visible", fix "Bring EasyWriter
to the front") is added by the executor to every `headless: false` command that `agent:assistant` calls, alone or as a batch step.
Every gate keeps a `message` and a `fix`.

**What counts as destructive** (binding for every namespace): a command that can remove something the user made — a draft, folder,
thread, tag, document block, board item, plan, ticket, plan column, estimate unit, label, saved view, holiday, checklist item or
link. Every id ending in `.delete` / `.remove` is destructive except the link removals `plan.deps.remove` and
`plan.tickets.labels.remove`. Removing a value is `write`: a draft's tag (`drafts.setTag`), text inside a block (`doc.replace`).

**Policy** (fixed; agents cannot change it):

| risk | `ui` / `palette` | `smoke` | `agent:*` (and `agent:assistant` in Standard) | `agent:assistant` Ask first | `agent:assistant` Read only |
|---|---|---|---|---|---|
| read | run | run | run | run | run |
| write | run | run | run (one undo step; Ctrl+Z undoes) | the agent card, on every call | denied `{reason: policy}` |
| destructive | run (the UI keeps its own confirm where the action has one) | run | the agent card, on every call | the agent card, on every call | denied `{reason: policy}` |
| approval | run (the existing confirm runs inside) | denied `{reason: policy}` | the agent card on every call, then the existing confirm | as Standard | denied `{reason: policy}` |

The assistant's column is its permission mode, `settings.assistant.permission`: `standard` (default; unset or unknown reads as
Standard) | `ask` | `readonly` | `all` (2026-10-07, the user: "add an allow all actions mode to assistant": write, destructive and
approval all run without a card; the chat header's badge reads "Allow all"; a push still only prepares the post, the user submits
it on the forum), chosen in Settings > Assistant (§7i) and never by an agent (that part of the dialog is
`data-agent-deny`, and `settings.patch` has no `assistant` key). `settings.assistant.uiControl` (default true) false refuses
`ui.snapshot` and `ui.invoke`, and the computer use commands (`computer.act`, `background.open`, `background.close`, §7i). The executor's policy step reads both from the settings at every call of source
`agent:assistant` (`tool-sets.mjs` `PERMISSIONS`, `assistantMode`, `refusal`), so a change applies to the next call, also in
the middle of a turn. A refusal is `denied {reason: policy}` with the message "Read only mode. Change it in Settings." or
"On-screen controls are off. Change it in Settings.", which the model gets and the step line shows. A batch takes the rule of
its highest-risk step; in Ask first its card lists every write, destructive and approval step. `ui.invoke` and `tool.run` ask
inside their run (a `tool.run` step is left off the batch's card and risk, so it never asks twice), with the pressed control's or the palette entry's own risk (`ui.invoke` in Ask first: every control asks),
so the executor only denies them. Other agents keep the `agent:*` column whatever the assistant's mode. The tool loop offers
and `commands.index` / `commands.describe` list only the commands the mode allows (§7i Tool loop).

`headless: false` → `denied {reason: headless}` for agents other than the in-app assistant (`agent:assistant` runs in this
window, so it gets the `window.visible` gate: `precondition_failed` while the window is hidden or minimized). Nothing is remembered: there is no "allow for this session"; a dry run
never asks. Approvals are by click only. No mode runs `doc.delete` (asked on every call), push or forum login without the
card (Read only refuses them); in Standard `doc.replace` never asks.

**Agent request card** (`AgentAsk.jsx`, mounted once after the tool search in App.jsx): the executor pushes
`{rid, source, title, description, risk, steps?, expires, resolve}` onto `state.agentAsk`; the card shows the first entry while no
dialog or confirm of the user's is open (it never uses the `confirm` slot). Fixed at the bottom right (1rem from the right, 6rem
from the bottom: above the bottom toolbar row), 22rem wide, z 45 (below dialogs), floating-surface style (`rounded-island`, border,
`bg-card`, shadow); while the §7i chat panel is open it shows inside the panel instead, above its input row (full width, at most
half the panel's height, scrolling), so it never covers the panel and moves with it. `data-board-chrome`: a badge "Agent · <name>", "wants to <title>" (e.g. wants to delete the draft "Week 3"
(moved to the trash)), the description, a batch's steps as a list, "+N more" when more wait; buttons Deny (outline, with a ring that
empties over the 60 s left) and Allow (primary; destructive variant for a destructive request). Its buttons never take the focus,
Escape does nothing to it, and no shortcut is blocked while it waits. Allow / Deny resolve it; 60 s without an answer →
`denied {reason: timeout}`; a cancelled call removes it.

**Batch** (`batch {steps: [{id, args}], atomic = true}`, 1–100 steps, no batch inside): every step's args, revision and gates are
checked first (an error names `steps[i]`); one card lists every destructive and approval step ("wants to make 2 changes in one
step"; a single such step shows its own text); the steps then run in order in the same queue turn. Every PATH in a batch refers to
the doc at the batch's start (or its `ifRev`) and is mapped when its step runs, so an earlier step's insert or delete is followed.
Doc steps form one undo step (the first transaction closes the history, the next ones join it as appended transactions). A failing
step stops an atomic batch and undoes its doc steps (other steps' effects stay); `atomic: false` runs on and reports per-step results.
Result `{results: [result | {error}]}`; one audit line per batch and per step. `ui.invoke` is never a step (`invalid_args`
"ui.invoke runs alone, not in a batch"). A dry-run batch dry-runs each step on the current doc.

**Events** (`on(type, fn)` → unsubscribe; coalesced: one call per 150 ms window with the latest payload, `settings.changed` keys
merged): `draft.changed {draftId, rev}`, `draft.opened {draftId}`, `drafts.changed`, `settings.changed {keys}`, `selection.changed
{kind: text | node | board | none, path?, ids?}`, `ui.changed {view, mode, busy}`; `emit(type, payload)` adds others
(`agent.connected` / `agent.disconnected {name}`). Sources: the store, the editor's transactions, the active board, the canvas editor.

**Audit**: one line per non-`ui` call (and per batch step) `{t, source, id, argsDigest, ok, code?, ms, draftId?, rev?, dryRun?}` in a
500-line ring in the renderer (`audit.tail`); `argsDigest` replaces every string over 1 KB by `{$len, $hash}` (cyrb53). A
`ui.invoke` line adds `control: {name, role, area}` and keeps the typed text only as `{$len}`. The `audit.jsonl` file comes with
the agent transport.

**Tool schemas** (`src/app/commands/tools-schema.mjs`, pure, test/tools-schema.test.mjs; automation plan §4.6, shared later with
the MCP bridge): `toolsFor(capabilities, {ids?, $defs, form = 'host' | 'model', family = 'qwen' | 'gemma'})` → OpenAI function tools `{type: 'function',
function: {name, description, parameters}}`: `name` = the id with `.` → `_` (`toolName`, defined in tool-sets.mjs); `parameters` =
the args schema through `rewrite(schema, $defs, {slim})`: every `$ref` inlined, `oneOf` → `anyOf`, a type list → `anyOf` of
single types (`type: ['string', 'null']` → `anyOf: [{type: 'string', …}, {type: 'null'}]`), `default` and `examples` dropped (the
executor still fills the defaults). Form `host` (app.capabilities consumers, the bridge later): `description` = the title, plus
` Needs: <gate>: <fix>; …` when the command has gates. Form `model` (the assistant's loop and `commands.describe`, with `$defs` =
`MODEL_DEFS`): `description` = the title (at most 90 characters, contract test) with a full stop, then the command's `brief`
when it has one, then "Not for: " and its `notFor` with a full stop when it has one (wave 1b), then "e.g. " and the JSON of its
first example's arguments (left out when they are `{}`), then a line per entry of its `guide` (wave 1c): "Before: …", "Args:
…", "Errors: …", "Playbook: …" (wave 2b), e.g. "Read the items of a whiteboard or canvas with their ids and labels. A sparse
answer lists the ids left out in next. Not for: draft text. e.g. {"path":[4]}\nErrors: precondition_failed means that path is
not a board. Call board_list." (wave 1 of the reliability plan; the Not-for line wave 1b; the guide lines wave 1c; the brief
wave 2b, §7i Tool loop sparse answers). Playbook lines (wave 2b, `guide.playbook`, the id of a §7i playbook, test: it exists and
names the tool): `board.items.add` "Playbook: change-board-item.", `batch` "Playbook: edit-draft-text.", `canvas.edit`
"Playbook: canvas-mode.". Guides
(wave 1c, the most-used tools): `doc.get` (args: outline first, then a path; errors: "A sparse answer lists the paths left out
in next.", wave 2b, a cut answer named the next path before, not_found), `doc.find` (args: words from the draft; errors: fewer words), `doc.insert` (before: read the paths; args: `at` a
path such as [3], not "[3]", content `{"markdown":"..."}`; errors: stale), `doc.replace` (before, args: the whole block,
errors: stale, a board denied), `doc.delete` and `board.items.remove` (every path or id in one call; denied means the user
said no), `board.get` (errors: precondition_failed → board_list), `board.find` (errors: hits 0), `board.items.update` (args:
patch holds only the fields to change; errors: not_found → board_find; these three lost their Before lines in wave 2 to fit the
board set, now that the attachment's lines name the ids and boxes), `board.items.add` (errors: "one of 6
forms" means a field is wrong for its type; its brief is now "Use it to draw only the new items the user asked for."),
`drafts.list` (args: usually none), `drafts.open` (errors: invalid_args on draftId means a title was sent) and
`commands.describe` (before: check your tools, never make up a name; errors: unknown). Model form per family (wave 1c,
`toolsFor({family})`, `familyOf` in §7i Tool loop; `commands.describe` uses the chosen model's): `qwen` as above, `gemma`
without unions, since Gemma 4's chat template renders a parameter from `type`, `enum`, `items`, `properties`, `required` and
`nullable` only (an `anyOf` came out as type "" with no alternatives, an untyped enum without its values): `rewrite(…, {slim,
flat})` makes a union (oneOf, anyOf, a type list) one schema of its first non-null branch's type with the alternatives in its
description (its own description, else `unionText`, "A list, or one of start, end"), a nullable one the non-null type with
", or null" added unless the description says null already (`drafts.setTag` tagId: type string, "A tag id from tags_list, or
null to clear it"), a union of required keys only (doc.format, drafts.reorder, tags.move) is dropped (the registry checks it),
and an enum gets a type: `string` (a null in it becomes `nullable: true`, doc.format's textColor, highlight and fontFamily) or
`number` with "One of 80, 90, ..." in the description (fontSize, settings baseSize), since the template shows an enum only on a
string. The unions in the catalogue and the branch kept: `doc.insert` / `board.insert` at (a path; start, end, cursor in words),
`ui.zoom` value (a number, listed first; "fit" in words), the nullable `drafts.create` / `drafts.setThread` threadUrl,
`threads.select` url, `settings.patch` selectedThread, `drafts.setTag` tagId, `drafts.move` folderId and `doc.format`
marks.link (each its non-null type). The qwen form keeps `anyOf`: llama.cpp b11433 builds Qwen3.5's tool-call grammar from the
parameter schemas (the qwen3_coder tool-arg rules in llama-common.dll), so one type there would forbid `"at": "end"` and
`"tagId": null`; Gemma's arguments are not held to the schema (the eval shows `names` sent as a string), and its template cannot
read a type list. Not-for lines (wave
1b, from the eval's wrong first calls): `canvas.edit` "It lets the user draw by hand. {} opens the selected one. Not for:
changing items. Use board_items_update." ("Use board_find and board_items_update." until wave 2b, which gave it its Playbook
line), `canvas.close` "saving", `ui.select` "changing items. No tool needs a
selection first", `commands.index` "finding items or blocks", `drafts.list` "opening" (its `threadUrl`: "Full forum thread URL.
Omit it for all drafts."), `drafts.open` "a title. Get the draftId from drafts_list first", `doc.get` "boards. Use board_get",
`board.get` and `board.find` "draft text", `board.items.remove` "a whole board block"; the briefs of `board.get`,
`board.items.remove`, `ui.select`, `drafts.open` and `canvas.close`, which restated their titles, went to make room; argument
descriptions are kept, also one written beside a `$ref`; `slim` also drops `additionalProperties`,
`minimum` / `maximum`, `minLength` / `maxLength`, `minItems` / `maxItems`, `minProperties` / `maxProperties`, `pattern` and
`title` (the registry still validates the full schema, and `invalid_args.data.expected` names the exact sub-schema), and `ITEM`
is `ITEM_BRIEF`: one flat object with `type` (text, shape, connector, image, stroke, canvas), the union of the item fields, the
shape, fill, align, route and dash enums, and the per-type fields, connector ends, anchors, heads and label slots in words (≤ 2 100
characters against ITEM's ≈ 13 000; the stroke fields `d`, `vw`, `vh` left out since wave 1b, as the model draws no pen strokes;
since wave 1c, to keep `board.items.add` within 2 600 in the gemma form, `heads` names the common heads only, "start, end: such
as none, arrow, triangle, diamond, circle, bar" (a wrong name's invalid_args lists them all), the canvas item's `items` is a
plain array and the field list is a little shorter).
Budgets (`tool-sets.mjs`, test/tools-schema.test.mjs, both families): one model-form tool ≤ 3 000
characters (`MAX_TOOL`; 2 800 before the board writes' `coords`, 2 600 before `draftId`); the core plus any one view set ≤ 14 000 (`MAX_SET`, about 4 000 tokens; 13 700 before
`coords` (core + board 13 945 gemma, board.items.add 2 935 gemma), 13 500 before `board.fit`, 11 500 before `draftId` (Background drafts: about 180 characters a routed tool, the brief sentence and the argument), 11 000 before `board.items.straighten`, 10 000 before wave 2's
`view.render` and `board.items.place`, 9 000 before wave 1c's guide lines, 7 000 before wave 1); property
descriptions in the sets ≤ 90 (ITEM_BRIEF's field lists excepted). Every command of the core and the view sets has a `brief` or
a `notFor`, and a description for every argument (test). Measured after wave 1c (qwen / gemma): core + editor 9 381 / 9 335
characters, core + board 9 647 / 9 791 (as offered: 9 022 qwen for a node-selected canvas, 9 614 gemma for a node-selected
whiteboard, some gates closed), core + none 5 294 / 5 254, core + plan 3 773 / 3 761, core + flows 2 648 / 2 664;
board.items.add 2 485 / 2 597; the whole catalogue in the model form 32 684 / 32 717. Measured after wave 2: core + editor
9 832 / 9 914, core + board 10 835 / 10 995 (5 characters to spare; to fit, the Before lines above went and `view.render` and
`board.items.place` describe `itemPath` as "A canvas item of that whiteboard, as its id"), `view.render` 452 / 452,
`board.items.place` 909 / 925, the whole catalogue 33 872 / 34 087. Measured after wave 2b: core 2 676 / 2 692, core + editor
9 877 / 9 959, core + board 10 829 / 10 989 (11 characters to spare; to fit the Playbook lines and `board.get`'s brief,
`board.items.add`, `board.items.update` and `board.items.remove` describe `itemPath` as "A canvas item of that whiteboard, as its
id" too, the reads `board.get` and `board.find` keep the long wording, `board.find`'s brief is "Use it for the id of an item the
user names." and `canvas.edit`'s Not-for line is shorter), core + none 5 322 / 5 282, core + plan 3 801 / 3 789, core + flows
8 818 / 8 994, `board.items.add` 2 476 / 2 588, the whole catalogue 43 600 / 44 075. Measured after `board.items.straighten`
(2026-10-07): core + board 11 335 / 11 495 (5 characters to spare; to fit, the command has no `itemPath`, its title is
"Straighten an arrow" and `board.items.update`'s Not-for line is "straightening. Use board_items_straighten"), core + flows
9 227 / 9 403, `board.items.straighten` 455 / 455, `flow.items.straighten` 410 / 410. To fit the Not-for lines, the board path is described as "Board block path, from board_list", `board.get`'s
`format` as "full adds every field", and `commands.index` is titled "List tool categories, or the tools of a category, view or
search". `commandIdOf(name, ids = the catalogue's)` maps a tool
name back by lookup among the ids (null: unknown). The in-app assistant (§7i Tool loop) calls commands as source
`agent:assistant`: its permission mode's policy (Policy above; Standard = the `agent:*` policy), audited like any agent, one
connection in `state.agent.connections` while its turn runs.

**Catalogue** (risk `read`, `undo: none` unless noted):
- `app.info` → `{appVersion, apiVersion: 1, userData: null, draftId, rev, loggedIn, agent: {enabled, hidden, connections}}`;
  `app.capabilities {available = false}` → `[{id, title, group, risk, undo, headless, slow, args, result, needs: [{gate, message,
  fix, byArgs}]}]` (`available`: only commands whose UI-read gates hold now; a gate read from the arguments is `byArgs` and checked
  when called); `ui.state` → `{view, mode: text | board | canvas-edit, tool, selection, busy: [dialog | confirm | gesture | editing |
  saving], visible, zoom, gates: {id: boolean}}`; `audit.tail {n = 50 (1–500), source?, draftId?}` → lines.
- `drafts.list {threadUrl?}` → `[{id, title, threadUrl, updated, pushedAt, tag, folder}]` in the sidebar order; `drafts.get {draftId,
  images = false}` → `{draft, rev?}` (the open draft from the editor with `rev`; pictures as `{$img: {len, hash}}` unless `images`);
  `drafts.create` (write) `{threadUrl?, folderId?, tagId?, content?}` → `{draftId, rev, dropped?}` (saved at once, opened without
  taking the focus); `drafts.open` (write) `{draftId}` → `{rev}` (agents leave `lastDraftId` alone); `drafts.delete` (destructive)
  `{draftId}` → `{draftId, trashed: true}` (drafts trash); `drafts.unpush` (destructive; needs `draft.pushed`) → `{draftId,
  previous}`; `drafts.setThread` (write) `{draftId, threadUrl | null}`, `drafts.setTag` (write) `{draftId, tagId | null}`,
  `drafts.move` (write) `{draftId, folderId | null}` → each `{draftId, <field>, previous}`; `drafts.reorder` (write) `{draftId,
  beforeId | afterId}` → `{draftId, folderId}` (the draft joins the target's folder, as a drag does). An unknown folder, tag or
  target → `not_found`.
- `doc.get {format = json | markdown | text | html | outline, path?, images = false}` → `{rev, draftId, content}` (Markdown renders a
  board as `![whiteboard: 3 items](block:[4])`; unless `images`, JSON gives each board as a placeholder `{type, kind, size, items,
  source?}` (`kind` from `blockKind`: flowchart, image, canvas, whiteboard; `size` "900 x 400" or "320 px high"; `source` "pasted
  PNG, 12 KB", the image URL or `library flowchart "<title>"`; a plan chart `{type, kind, plan, view, frozen?}`) and HTML replaces
  each board's `data-json` with `data-summary="flowchart, 900 x 400, 5 items"`; `board.get` reads the items); `doc.find {text, regex?,
  caseSensitive?}` → `[{path, from, to, context}]`; `doc.selection` → `{kind: 'text', path, from, to, text, context, toPath?}`
  (block-local offsets; `toPath` when the selection ends in another block, `to` then counts in it) | `{kind: 'node', path, type}` |
  `{kind: 'none'}`; `doc.insert` (write, `undo: doc`) `{at: PATH | start | end | cursor, position = after | before, content}` →
  `{paths, dropped?}` (`cursor` = after the block holding the selection, which does not move; content holding a board goes at the
  top level, after the top-level block of `at`); `doc.replace` (write, `undo: doc`) `{path, content}` → `{path, paths, dropped?}` (not
  a board; a board in the content of a nested block → `refused {code: nested_board}`); `doc.delete` (destructive, `undo: doc`)
  `{paths}` (1–100) → `{deleted}` (one transaction, last block first; a block inside another deleted one goes with it; deleting every
  top-level block leaves one empty paragraph).
- `history.undo` / `history.redo` (write, `undo: doc`; need `history.canUndo` / `history.canRedo`; `busy` while a live board is
  mid-gesture or editing) `{steps = 1 (1–50)}` → `{undone | redone, undoDepth, redoDepth}` (no scrolling, no focus);
  `history.state` → `{undoDepth, redoDepth, rev}`.
- `ui.select` (write) `{path?, ids?}` (at least one) → `{kind: 'node', path}` | `{kind: 'board', ids}`: the one command that moves the
  selection, focuses and scrolls — a node selection of the block at `path`, or the items `ids` of the whiteboard at `path` (no `path`:
  of the active board) selected and that board focused; a canvas's items → `refused {code: not_a_whiteboard, hint}`; an unknown id →
  `not_found {ids}`. `ui.scrollTo` (write) `{path}` → `{path}`: the block centred in the page's viewport (its top when taller; scrolled
  sideways only when it is out of view), no selection change, no focus. `ui.notice` (write) `{text}` (1–120 characters): the §7c
  notice pill. `ui.zoom` (write) `{value: 'fit' | 10–400}` → `{zoom, previous}` (as the status bar's zoom).
- Application control (automation plan section 13.11, user decision 2026-10-06, built 2026-10-06) is the fallback when no command
  does the job. Both commands are `headless: false`, category app, and in no view set (the assistant adds them with
  `commands_describe`).
  - `ui.snapshot` (read) `{scope?: view | dialog | menu, page = 1 (1-100), query?}` returns `{page, pages, total, groups: [{area,
    nodes: [{ref, role, name, in?, state?, value?, risk?, bounds}]}]}`, read in the renderer from this window's DOM (no CDP).
    Listed: visible controls (buttons, links, inputs, selects, textareas, summary, the ARIA widget roles, `tabindex="0"`, and any
    element whose own cursor is a pointer, such as a sidebar row), including row actions that show on hover. Skipped: `inert` and
    `aria-hidden` subtrees (an open modal dialog hides the rest of the app, so only the dialog is listed), `display: none` and
    zero size. `name` = aria-label, aria-labelledby, a label element, the text, the title or the placeholder (60 characters; a
    slider thumb takes its slider's label); `in` = the list row a row action belongs to (Tailwind `group` rows, so `Delete draft`
    has `in: "Week 3"`); `state` from disabled, checked, pressed, selected, expanded, current, focused; `value` = a text field's
    value, a select's shown option or a slider's value; `risk` = destructive or approval when pressing it asks; `bounds` =
    `[x, y, w, h]` in window CSS px (the model never sends coordinates). `area` = dialog (a modal), menu (a Radix popover, menu or
    select list), the nearest `data-agent-area` (sidebar, toolbar) or toolbar label (text tools, board tools, item properties and
    so on), status (the status bar), notices, or page. Order: dialogs, then menus, then the other areas in the order they first
    appear, each area's controls together; a page holds whole nodes while it stays under about 3 000 tokens (characters / 3); a
    page past the last has no groups. `total` counts every match. `scope` keeps one kind of area; `query` keeps the controls whose
    role and name hold every word (case-insensitive). A `ref` (`e1`, `e2`, ...) stays the same for the same element while it
    lives (a WeakMap in ui-control.js; nothing is written to the DOM).
  - Never listed and never pressed (`denied {reason: policy}`): password fields (never their values) and file inputs; undo and
    redo controls (as `history.undo` / `history.redo` are never offered); the assistant panel and its button (`#assistant-panel`, `[data-chat-island]`); the approval card (`[data-agent-ask]`); the title
    bar (`[data-titlebar]`); the editor and boards (`.ProseMirror`, `.wb`, contenteditable, as text and items go through the doc
    and board commands); and every subtree marked `data-agent-deny`, which covers the push-to-talk mic, the status bar agents
    popover with Disconnect, Settings > Assistant (status, permissions, on-screen controls, install, model, backend, delete, idle unload, server fields), Settings >
    Dictation advanced server fields and the "Allow local AI agents" switch. A label is judged as its control, and a Radix menu or
    list in its portal as the control that opened it (`aria-controls`), so neither escapes a denied subtree. The forum window and OS dialogs are other windows,
    so they cannot be reached; the window controls are native (title bar overlay) and not in the DOM.
  - `ui.invoke` (write, `undo: doc`) `{ref, action: click | type | select | key, text? (type: the new text, at most 2 000
    characters), value? (select: the option's name), key? (Enter, Escape, Tab, Space, ArrowUp, ArrowDown, ArrowLeft,
    ArrowRight, Backspace, Delete, Home, End)}` returns `{ref, action, name, in?, role, area, changes}`. One element per call,
    with DOM events dispatched on that element only (never OS input). click = pointermove, pointerdown, mousedown (then the
    focus, unless prevented, as a toolbar button prevents it), one frame, pointerup, mouseup, click at the element's centre.
    type = the value of a text input or textarea set through the native setter (React sees it), then input and change. select =
    a native select's option, or a Radix select's trigger clicked and then the option of that name in its list (no match gives
    `not_found` with the option names, and the list is closed with Escape). key = keydown and keyup with no modifiers, so no
    shortcut can be sent. It then waits two animation frames and 150 ms and returns `changes`, what changed among the focus, the
    open dialog and the open menu (null = closed), the control's own name, value and state (`gone: true` when it left the
    screen) and new notices or toasts (`{}` = nothing visible changed).
  - Refusals: a ref no longer on screen `stale`; a denied control `denied {reason: policy}`; a control not shown now (behind a
    modal dialog) `refused {code: hidden}`; EasyWriter without the focus (a native dialog, the forum window or another program
    has it) `refused {code: not_focused}`; a disabled control `refused {code: disabled}`; type on a non-text control
    `refused {code: not_a_field}`; the key Delete or Backspace to anything but a text input, a textarea or contenteditable
    `refused {code: not_a_field}` (a list's key handler could remove its selected row, such as a Gantt dependency;
    `ui-tree.mjs` `keyRefusal`); select on a non-select `refused {code: not_a_select}`; Enter or Space in a list with a
    highlighted item (`aria-activedescendant`, the tool search), which acts on that item, `refused {code: use_click}`; a missing `text`, `value` or `key`
    `invalid_args`; more than 20 calls a minute `refused {code: rate_limit}`.
  - Approval: the control's `data-agent-risk="destructive|approval"` (on the app's own such buttons, where Delete draft, Delete
    folder, Remove thread from list and Unpush are destructive and Push to forum, Log in / Forum window and a thread row's Open
    in forum ask approval, and the confirm dialog's button is destructive when the confirm is), else
    the name rules (delete, remove, discard, trash, erase, wipe, clear all, uninstall, reset are destructive; push, unpush,
    publish, send, submit, log in, sign in, log out, sign out, install, download ask approval). Such a control follows the
    policy table (`ctx.policy[risk]`; the assistant in Ask first asks for every control, in Read only `ui.invoke` is refused
    before it runs). For an agent that is the approval
    card on every call, "wants to press "Delete draft" on "Week 3" in the sidebar" (refused at once while the user's own dialog
    or confirm is open, as the card cannot show over it; a control whose name, row or visibility changed while the card waited
    gives `stale`); `smoke` runs destructive ones and is denied approval ones. Stop cancels
    a waiting card, and nothing is dispatched after it. Each call is a step line in the chat and an audit line.
  - Not built yet: the Set-of-Marks screenshot (automation plan section 13.10). The answer is text only.
- `canvas.edit` (write, `undo: doc`; needs `doc.open`, `view.editor`, `node.canvas` for a `path` alone, `node.whiteboard` for a
  `path` with `item`; `busy` while a live board is mid-gesture or editing) `{path?, item?}` → `{path, item?, converted?}`: Canvas
  Mode (§6b) on the canvas block at `path`, or on item `item` (a picture or canvas item) of the whiteboard at `path` (no `path`:
  the whiteboard holding it), its block scrolled into view (an open Canvas Mode left first, as by a click outside), through the
  UI's code: the canvas bar's Edit, the item ribbon's Edit
  and a double-click (a picture becomes a canvas item first, one undo step: `converted: true`). No arguments: the one picture or
  canvas item selected on the active whiteboard; with no board active (the chat box holds the focus) the node-selected canvas or
  the one whiteboard holding such a selection (both linger after a click elsewhere); several → `refused {code: ambiguous,
  candidates: [{path, item?}]}`; none → `precondition_failed` naming `node.canvas` and `board.itemIs`. Another item type →
  `refused {code: not_a_canvas}`; an unknown id → `not_found {ids}`; Canvas Mode not open afterwards → `failed`. `canvas.close`
  (write; needs `view.editor`, `board.canvasMode`; the same `busy`) → `{closed: true}`: as the edit bar's Done and Escape (an open
  text edit is committed, the canvas selected again). Both are headless (agents run them), category board.
- `settings.get {keys?}` → the settings, or the listed keys (`assistant.apiKey` left out); `settings.patch` (write) `{patch}` with
  only `forumWidth` (320–4000), `theme` (dark | light), `baseFont` ('' or a FONTS css name), `baseSize` (FONT_SIZES),
  `historyLimit` (0–500), `sidebarCollapsed`, `selectedThread` (a listed thread URL or null; not listed → `not_found`) → `{keys,
  previous}`; applied as the Settings dialog does (a theme or undo-depth change remounts the editor, history kept).
- `tags.list` → `[{id, name, color, drafts}]` in workflow order; `tags.add` (write) `{name, color?, id?}` → `{tagId}` (appended; id a
  random UUID unless an unused one is given, a used one → `already_exists`; colour default `#a3a3a3`; name trimmed);
  `tags.update` (write) `{tagId, patch: {name?, color?}}` → `{tagId, previous}`; `tags.move` (write) `{tagId, beforeId | afterId}` →
  `{tagId, index}`; `tags.remove` (destructive) `{tagId}` → `{tag, draftIds}` (the drafts that carried it become untagged).
- `folders.list` → `[{id, name, open, drafts}]`; `folders.create` (write) `{name}` → `{folderId}`; `folders.rename` (write)
  `{folderId, name}` → `{folderId, name, previous}`; `folders.delete` (destructive) `{folderId}` → `{folder, draftIds}` (its drafts
  move to the top level). An unknown tag or folder → `not_found`.
- `threads.list` → `[{url, title, subject, year, forum, selected}]`; `threads.add` (write) `{url, title?}` → `{url}` (normalised: query
  and hash dropped; listed → `already_exists`); `threads.remove` (destructive) `{url}` → `{thread, selected}` (drafts kept);
  `threads.select` (write) `{url | null}` → `{url, previous}` (the sidebar's thread filter; the page is not changed);
  `threads.discover` (write, slow) → `{added, total}` (as Find my threads; logged out → `failed {reason: not-logged-in}`);
  `threads.openInForum` (approval: it loads the forum site, so an agent asks on the card, "wants to open a forum thread in the
  forum window" with the URL; `headless: false`) `{url}` → `{url}`. An unlisted URL → `not_found`.
- `doc.format` (write, `undo: doc`) `{path, from?, to?, marks?, block?, presetId?}` (at least one of marks, block, presetId) →
  `{path, from, to}`: one transaction on the textblock at `path` (not text → `refused {code: not_text}`), over its block-local range
  (default: the whole block; outside it → `invalid_args`); `marks`: `bold italic underline strike sub sup code` (true sets, false
  unsets), `fontSize` (FONT_SIZES | null), `textColor` (TEXT_COLORS key | null), `highlight` (HIGHLIGHTS | null), `fontFamily`
  (FONTS css | null), `link` (href, https:// added without a scheme | null); `block`: `{type: paragraph | heading, level (a heading's,
  1–6), align: left | center | right | justify}`; `presetId`: a font preset's id, applied first as Alt+n does (unknown →
  `not_found`). The user's selection is mapped, not moved.
- `doc.command` (write, `undo: doc`; row and column commands need `doc.inTable`) `{name, args = []}` → `{name}`: one allowed TipTap
  command on the selection, as one transaction: `toggle/set/unset` + Bold, Italic, Underline, Strike, Subscript, Superscript, Code;
  `setLink`, `unsetLink`; `set/unset` + FontSize, TextColor, Highlight, FontFamily; `setTextAlign`, `setParagraph`, `setHeading`,
  `toggleBulletList`, `toggleOrderedList`, `toggleBlockquote`, `toggleCodeBlock`, `setHorizontalRule`, `insertTable` (≤ 50 rows, 20
  columns), `addRowBefore/After`, `addColumnBefore/After`, `deleteRow`, `deleteColumn`, `insertBox`, `unsetAllMarks`, `clearNodes`,
  `setTextSelection`, `setNodeSelection`. Any other name → `denied {reason: policy, hint}`; `editor.can()` false → `refused {code:
  cannot_apply}`; a node-selected board (other than the two selection commands) → `refused {code: board_selected, hint}`.
- `tool.list` → `[{id, label, group, shortcut, hasOptions, active, risk, headless, command?}]`: the palette entries that apply now
  (the canvas being edited, else the active board, else the document); `tool.run` (write, `undo: doc`) `{id}` → `{id, active?}` (a
  command entry: its command's result): runs the entry as Enter in the palette; an entry that does not apply →
  `precondition_failed` with its failing gates; options only → `refused {code: options_only}`; `headless: false` → `denied
  {headless}` for agents; the entry's `risk` applies (destructive: the agent card on every call; approval: denied for smoke).
- `batch` (risk: the highest of its steps); a step `id` may be a tool name (`doc_insert`) or a command id.
- `board.get {path, itemPath?, format = brief | full, images = false}` → `{rev, draftId, board}`. `brief` (the default, wave 1 of
  the reliability plan): `board` = `{kind, w, h | height (a whiteboard: its drawn width and height), id? (a canvas item), bg,
  items}`, each item `{id, type, shape?, label? (the plain text of html or labels.mid, cut at 120 characters), x, y, w, h (whole px)}`, a connector also
  `from` / `to` (`{item, label?, side}` or `{x, y}`; `side` the anchor's side in words as the attachment's item lines name it,
  "bottom", "nearest side", 2026-10-07), `route`, `head` (heads.end) and `bends` (the waypoint count; `points` before
  wave 1c, renamed to match the attachment's item lines, §7i Attachments), a canvas item `items` (the
  count); no `d`, `src`, `vw` / `vh` or `html`. `full`: every field as stored (pictures shortened unless `images`).
  `board.find {path, itemPath?, q}` (read) → `{rev, draftId, hits, items, sparse?, next?, hint?}`: the brief items whose words contain every word of
  `q` (case-insensitive; a, an, the, of, on, in, to and are skipped), at most 40, `hits` the full count; past 40 the answer is
  sparse (wave 2b, as the assistant's sparse answers, §7i Tool loop): `sparse: true`, `next` the ids of the hits left out and
  `hint` "Read one with board_find {"path":[p],"q":"<the first of them>"}."; an item's words are its
  label, type, shape kind and the kind's name ("Decision"), "arrow line" for a connector with "from <label> to <label>" of its
  ends, "picture" for an image, "pen drawing" for a stroke, so "the yes arrow" finds the connector labelled yes; a `q` that is an
  item's id puts that item first among the hits (wave 2b, so a sparse answer's `next` ids can be read, also an id that is a
  skipped word or matches more than 40 items). `itemPath`
  (both, and every board command): "Only for a canvas item inside a whiteboard, as its id. Omit it for a canvas block." (since
  wave 2b only on the reads `board.get` and `board.find` and on `board.items.arrange` and `board.render`; the writes in the board
  set, `board.items.place` and `view.render` say "A canvas item of that whiteboard, as its id", for the budget); on a
  canvas block it answers `invalid_args` "itemPath is only for a canvas item inside a whiteboard. This block is a canvas, so
  omit itemPath."
- New items match the board (2026-10-07, `src/app/commands/item-style.mjs`, after the user asked for annotations, flowchart items
  and text notes in the page's own colours): in `board.items.add` and `flow.items.add` each style field an agent leaves out comes
  from the target board's own items of the same type (a shape: of its kind when the board has one, else any shape), the most
  common style among them, the latest on a tie; a board with no item of that type takes the rest of the page's (every board's
  items in the draft, canvas items' own too, `pageItems`), so a blank board's marks match the page's other boards; fields the
  agent sets stay; with no item of that type anywhere the theme defaults apply (ink by theme, fill none). Style fields: text `size, color, bold, align, bg`; shape `color, width, opacity, fill, fillColor,
  size, textColor`; connector `color, width, opacity, dash, route, corner, heads, jump`; stroke `color, width, opacity`. The
  target's items are the canvas item's own for an `itemPath`. `board.get` brief adds `styles` (the most common style per type
  present), and the `items` argument says "New items. Your ids link connectors. Left-out styles match the board." The
  change-board-item playbook's add step ends "Leave colours out."
- A bare string where a command's args schema wants an array at the top level is taken as a one-item array before validation
  (2026-10-07, `commands.js` wrapStrings, also for batch steps): `itemPath: "k3j9x0a"` is `["k3j9x0a"]`, since its description
  says "as its id" (eval set 5's stub found the refusal).
- `board.items.update {path, itemPath?, id, patch}` (write): `patch` fields replace the item's, `labels` and `heads` merge per
  slot (null removes one); `id`, `type` and a canvas item's `items` cannot change. A connector patched to `route: 'straight'`
  without `points` of its own loses its waypoints (wave 1b, `board.mjs patched`): a connector with waypoints stays bent whatever
  its route, so before this "straighten the yes arrow" stayed bent unless the call also sent `points: []`. Its brief says so: "Use it to move or restyle an item.
  route straight also drops an arrow's bends." → `{id, item (as stored: clamped, its route redone), warnings?}`. Its Not-for
  line (2026-10-07): "straightening. Use board_items_straighten".
- `coords: px | thousandths` (default px) on `board.items.add` and `board.items.update` (2026-10-08, §7i Board coordinates in
  thousandths): "thousandths: x, y, w, h are 0 to 1000 of the board's width and height". The app converts the new items' or the
  patch's x, y, w, h and a connector's free ends and waypoints to board px of the target before it checks them.
- `board.items.place {path, itemPath?, id, relation: left | right | above | below, of, gap = 24 (integer, 0 to 2000), align = true}`
  (write, wave 2 of the reliability plan, after the eval's move-valve case): reads both boxes (a whiteboard's through
  `Board.itemBox`, which measures text; elsewhere the stored box, a text without `h` counting as 0 high; a turned shape's
  bounding box) and moves the item by `moveItem` (a connector as `id` or `of` → `invalid_args`: it moves with its ends and has
  no box of its own): left x = of.x - gap -
  w, right x = of.x + of.w + gap, above y = of.y - gap - h, below y = of.y + of.h + gap; `align` keeps the other axis lined up
  with `of` (the tops for left and right, the left edges for above and below), false leaves it (`placeAt`, pure). One undo step
  through the board's write route, so a whiteboard clamps it. → `{id, item: {id, x, y, w, h}, of: {id, x, y, w, h}}`, both
  boxes as stored. Brief "The app works out x and y."
- `board.items.straighten {path, id}` (write, `undo: doc`, needs `doc.open` and `node.board`; `connectors.mjs`, 2026-10-07, after
  the user saw every eval run fail straighten-yes): route straight, no points, and each end on an item moved to the side of its box
  that faces the other end (`facing`, pure): when the horizontal gap between the two boxes is larger than the vertical one (a gap is
  negative where they overlap on that axis), the left box's e and the right box's w, else the upper box's s and the lower box's n
  (left, right, upper and lower by their centres). A turned shape's side is picked by its bounding box and gets the anchor that its
  rot has turned onto that side. A free end counts as a box of size 0 and stays; an end on an item without a box keeps its anchor;
  heads and labels stay. Boxes are read as `board.items.place` reads them. The write is `board.items.update`'s run with that patch
  (one undo step, routed, clamped). A shape's id or an arrow with both ends on one item → `invalid_args`, an unknown id →
  `not_found`. → `{id, item (as stored), from, to}`, each end `{id, x, y, w, h, side}` or a free end's `{x, y}`. Title "Straighten
  an arrow", brief "Route straight, no bends, ends moved to the facing sides. Use it for 'straighten', 'tidy' or 'fix this
  arrow'." No `itemPath`, for the board set's budget: an arrow in a canvas item takes `board.items.update`.
- `board.fit {path, draftId?}` (write, `undo: doc`, needs `doc.open` and `node.board`; 2026-10-07, after the user asked to "resize
  whiteboard to fit" and the model, with no resize tool in the board set, widened a text item): sets the whiteboard's `base` to 80,
  so its drawn height becomes its lowest item bottom + 20 (the rail's Fit height). A canvas → `invalid_args` naming `board.set`
  attrs w and h. → `{path}`. Title "Fit a whiteboard's height to its items", brief "Use it to resize or shrink a whiteboard to fit."
  In the board set (MAX_SET 13 700, 13 500 before it).
- `view.render {path?, itemPath?}` (read, `headless: false`, group ui, `src/app/commands/render.mjs`, wave 2): with `path` (and
  `itemPath` for a canvas item of that whiteboard) the board's marked picture as an attachment's (§7i Vision, `marks.mjs
  boardPicture`) and the legend "<Whiteboard | Canvas | Canvas item <id> of the whiteboard> at block [p] with N items" with its
  numbered item lines (`listBody`, 2 000 characters); without, the page viewport (`[data-viewport]`, `viewportRect`) as the user
  sees it: main captures the window (`window.capture` → `webContents.capturePage().toPNG()`; the renderer asks through
  `ctx.lib.capturePage`), the renderer crops the viewport (capture px per CSS px = the PNG's width / `innerWidth`, so the device
  scale and the page zoom drop out), at most 1 280 px on the long side and never above the capture's own size, and marks the
  items of the draft's boards whose badge falls inside it (whiteboards and canvases through `nodeDOM`, board px → CSS px by the
  drawn width; none on a workspace page), numbered per board; legend "The view as the user sees it. Board items, numbered per
  board:", then per board "<Whiteboard | Canvas> at block [p]" and its lines. Gates `doc.open` and `node.board` only with
  `path`. → `{legend, width, height, size, picture: 'next message', url}` (`size`, wave 2b, `marks.mjs sizeText`: the picture's
  px and what it shows, "1280 x 568 of a 900 x 400 board" (a whiteboard at its drawn width and height, a canvas at its artboard)
  or "1280 x 800 of a 1600 x 1000 view" (the viewport in CSS px), so the model knows the scale while the legend keeps board px;
  `url` the PNG data URL, which the assistant's loop takes out and
  sends as the next user message, §7i Tool loop). Brief "Use it when the target is visual or ambiguous."
- Computer use (`src/app/commands/computer.mjs`, 2026-10-08, §7i Computer use and Background window; group ui, `undo: none`,
  in `tool-sets.mjs COMPUTER` and `UI_CONTROL`, offered to the cloud models only; main does the work through `ctx.api.computer`
  and answers `{error, code}`, which the command throws as that code):
  - `computer.act {action: screenshot | click | double_click | move | drag | type | key | scroll | wait, target: main |
    background = main, x?, y?, button?: left | right | middle, path?: [[x, y], ...] (2 to 50), text? (1 to 2,000), keys? (1 to
    40), dx?, dy?, ms? (1 to 3,000)}` (read: its screenshot; the input actions refuse in Read only and ask in Ask first in their
    run) → `{width, height, size, picture: 'next message', url}` (`size` "1344 x 840 screenshot of the main window" or "... of
    the background window, draft "<title>""; `url` a JPEG data URL the loop sends as the next user message). x, y and the path
    are pixels of the last screenshot of that target. Missing arguments: `invalid_args` "args.x is needed for click" (x and y
    for click, double_click, move and scroll, path for drag, text for type, keys for key, ms for wait); undo and redo keys on
    main: `refused`. Title "Look at a window as a screenshot, or click, drag, type or press keys in it", brief "Use it for
    visual work such as drawing by hand. x and y are pixels of the last screenshot of that window. Each action answers with a
    new screenshot.", Not for "changes a draft or board tool can make. Use that tool".
  - `background.open {draftId}` (write) → the screenshot answer with `draftId`: that draft in the background window (`refused`
    for the draft open in the main window). Title "Open another draft in the background window and look at it", brief "Use it
    to work on a draft by hand while the user keeps working in theirs, then use computer_act with target background.", Not for
    "the draft open in the main window".
  - `background.close {}` (write) → `{closed: the draft id, or null}`: saves and closes the background window. Brief "Use it
    when the work there is done. It also closes by itself 5 minutes after its last action."
  Model form (qwen form, which the cloud family uses): `computer.act` 1 628 characters, `background.open` 522,
  `background.close` 253.
- `flow.*` (`src/app/commands/flow.mjs`, built 2026-10-06, wave 3 of the reliability plan; assistant-coverage plan §3.6): the
  flowchart library (§6f) by `flowId` (`#/$defs/ID`, "From flow_library_list"), through the store as `ctx.flows` (the module
  never imports flows.js, so the catalogue stays Node-importable). Group `board` (category board) until `tool-sets.mjs`
  `CATEGORIES` has a `flow` line. No `flow.present` gate: the executor reads no flow subject from the arguments, so each command
  loads the record and answers `not_found` "No flowchart has the id <id>. Call flow_library_list" for an unknown one.
  - Reads (`undo: none`): `flow.library.list {threadUrl?}` → `[{flowId, title, items, updated}]` (newest first);
    `flow.library.get {flowId, format = brief | full}` → `{flowId, title, rev, board}`, `brief` = `{w, h, bg, items}` with the
    items as `board.get`'s brief, `full` = `{w, h, frame, bg, items}` as stored (pictures shortened); `flow.find {flowId, q}` →
    `{hits, items}`, matched as `board.find`.
  - Item writes (`undo: own`, the record's undo stack, so the library editor's Undo and Ctrl+Z revert them): `flow.items.add
    {flowId, items}` → `{ids, warnings?}`, `flow.items.update {flowId, id, patch}` → `{id, item}`, `flow.items.place {flowId, id,
    relation, of, gap = 24, align = true}` → `{id, item, of}` (boxes as stored, a text without `h` by its estimate,
    `defaultMeasure`), `flow.items.straighten {flowId, id}` → `{id, item, from, to}` (as `board.items.straighten`, 2026-10-07;
    title "Straighten a flowchart arrow", brief "Its ends move to face each other."), `flow.items.remove {flowId, ids}` (destructive; card "remove an item from the flowchart "<title>" (Undo in
    the library restores it)" with the items) → `{removed}`, `flow.layout {flowId, dir = TB | LR | BT | RL}` → `{laid}` (Auto
    layout without a Board: the shapes, text, images and groups laid out by dagre from where the drawing began, connectors between
    them lose their waypoints; no shrink, the board is fixed). The arguments and checks are the `board.*` ones with `flowId` in
    place of `path` (no `itemPath`; a canvas item fails `board.whiteboard`). Each write takes the record's board, settles it as
    `board.mjs` does for a canvas (connectors routed, text measured offscreen, the smart artboard) and commits it with
    `commitLibrary(id, board, true)`: a new rev, one undo step of its own, and every view follows at once (the library editor's
    Board through `flowSource.subscribe`, the synced canvases in drafts; the briefs of add and update say "Synced canvases update
    too."). `busy` while the library editor's Board on that flowchart is mid-gesture or editing text, or a synced canvas of it is
    open in Canvas Mode.
  - `flow.insert {flowId, at?}` (write, `undo: doc`, needs `doc.open`): a synced canvas of the record (its board, `flow: {id,
    rev}`, `dw` = min(w, content width), its `source`) after the top-level block of `at`, else at the end, as one transaction (Insert
    into draft… with Synced, without the dialog and without Canvas Mode) → `{path}`.
  - `flow.open {flowId}` (write, `undo: none`, `headless: false`, so the assistant gets the `window.visible` gate): `openFlows(id,
    {remember: false})` → `{flowId}`; a failed draft save → `failed`.
  - `flow.library.create {title, threadUrl?, board?: {w?, h?, bg?, items?}}` (write, `undo: none`) → `{flowId, title, threadUrl}`:
    a new record (1200 × 675 unless given), its items checked and settled as `flow.items.add`'s; `threadUrl` omitted = the open
    draft's thread, else the selected one; null = No thread. `flow.library.rename {flowId, title}` (write) → `{flowId, title,
    previous}` (`updateFlow`; the synced badges follow). `flow.library.delete {flowId}` (destructive, `undo: none`): card "delete
    the flowchart "<title>" (moved to the flowcharts trash)", described by its synced canvases in the open draft ("Its synced canvas
    in this draft becomes a plain copy.") and "Synced canvases in other drafts keep their last picture and show "missing"."; then
    `removeFlow(id, {ask: false})` (no second confirm) → `{flowId, deleted: true}`.
  - `FLOW_VIEW_SET` (exported for `VIEW_SETS.flows`): `flow.library.list`, `flow.library.get`, `flow.find`, `flow.items.add`,
    `flow.items.update`, `flow.items.remove`, `flow.items.place`, `flow.items.straighten`, `flow.insert`, `flow.layout`; with the
    core 9 227 characters in the qwen form, 9 403 in the gemma form (test/flow-commands.test.mjs: under 9 500; under 9 000 before
    `flow.items.straighten`, which no shortening of the flow briefs could absorb).
- `commands.index {category?, view?: editor | board | plan | flows | none, q?}` → no filter: `{categories: [{category, about,
  count}]}` (category = `tool-sets.mjs` `categoryOf`: groups app, ui, audit, settings, tool, batch, commands → app; drafts, tags,
  folders, threads → drafts; canvas → board; export, push, forum → export; any other group is its own category); any filter (they AND together):
  `{tools: [{name, about: the title, risk}], more?, playbooks?}`, at most 40; `view` = the core plus that view's set; `q` (≤ 60
  characters) = words found in the tool name, title and category, case-insensitive, and also `playbooks: [{id, title, text}]` (wave
  1b, §7i Playbooks, `findPlaybooks`; the id wave 2b): at most 2 playbooks whose id, title or triggers hold every word of `q` longer than 2 letters,
  among those the assistant's permission mode allows; an unknown category → `not_found` naming the categories.
  `commands.describe {names}` (1–6 tool names or command ids) → `{tools: [model-form tools], risk: {name: risk}, unknown: [names]}`
  through `ctx.lib.tools(ids)` (`toolsFor(capabilities(false), {ids, $defs: MODEL_DEFS, form: 'model', family})`, `family` from
  `settings.assistant.model`, prompts.mjs `familyOf`).
- Titles are at most 90 characters (contract test). Shortened on 2026-10-06: `board.set` "Change a board's background, base
  height, artboard size, frame or displayed width", `board.items.add` "Add items (text, shapes, connectors, pictures, strokes,
  canvases) to a board", `board.items.update` "Change one item of a whiteboard or canvas (labels and heads merge per slot)",
  `doc.format` "Format the text of one block with marks, block type, alignment or a font preset", `doc.command` "Run one allowed
  editor command on the selection (marks, lists, tables, selection)", `settings.patch` "Change display settings such as forum
  width, theme, base font and undo history", `export.preview` "Build the post HTML and pictures that Push would send for the open
  draft", `push.prepare` "Fill the forum reply box with a draft (the user confirms and submits it)", `ui.select` "Select a block or
  items of a board, and bring it into view with the focus", `ui.scrollTo` "Scroll a block into the middle of the view (no
  selection change, no focus)". Shortened again in wave 1 of the reliability plan (the board set's budget): `board.items.add`
  "Add items to a whiteboard or canvas", `board.items.update` "Change one item of a whiteboard or canvas", `board.items.remove`
  "Remove items from a whiteboard or canvas", `board.get` "Read the items of a whiteboard or canvas with their ids and labels",
  `canvas.edit` "Open a smart canvas or a whiteboard picture in Canvas Mode", `ui.select` "Select a block or board items and
  bring it into view", `ui.state` "Describe the view, mode and selection now".

**Smoke script and `window.__agent`**: once the app has started (the end of actions.js `init`), `window.__agent = {invoke,
script(steps), on, catalogue()}`. `script` runs `[{id, args?, dryRun?, ifRev?, expect?: {ok?, code?, undoSteps?, result?, error?}}]`
in order as source `smoke` → `[{req, res, pass}]`; a string `"$prev.<path>"` / `"$steps[i].<path>"` anywhere in `args` or `ifRev`
is replaced by that dotted field of an earlier answer (`$prev.rev`, `$steps[0].result.draftId`, `$steps[2].result.0.path`).
`expect.result` / `expect.error` match partially (objects key by key, arrays index by index); a missing `expect` means `{ok: true}`;
a step of an `undo: doc` command that made more than one undo step fails. `test/smoke/agent-basic.json` is the scripted acceptance
(drafts.create → doc.insert Markdown → doc.find → doc.insert → doc.replace with `ifRev` → doc.get → a dry-run doc.delete →
history.undo → doc.get outline → drafts.setTag → drafts.unpush (`precondition_failed` naming `draft.pushed`) → tags.add →
drafts.setTag → tags.remove → settings.patch (forumWidth) → threads.add → threads.add again (`already_exists`) → threads.remove →
doc.format (bold over a range) → doc.get (Markdown of that block) → doc.command setHeading → doc.command deleteSelection
(`denied {policy}`) → tool.list (holds Bold) → board.insert, board.items.add / update, board.render, board.items.remove →
export.preview → push.prepare (`precondition_failed` naming `draft.hasThread`) → commands.index (categories) → commands.index
board (holds `board_items_add`) → commands.describe `[board_set, nope]` (one tool, `unknown: [nope]`) → batch of two doc.insert steps,
the first by its tool name `doc_insert` (one undo step) → drafts.delete). It leaves no thread or tag behind, so it can run again on the same
data dir.

**Agents** (the MCP server, 2026-10-08; agent-automation plan §4.4-§4.6 without the token, the user's decision): while
`settings.agent.enabled` (also switched live by `settings.set`; never in smoke mode), main's `src/agent-server.js` serves MCP over
two transports. Streamable HTTP at `http://127.0.0.1:<settings.agent.port, default 47823>/mcp`: POST one JSON-RPC message (or an
array) with `Content-Type: application/json`, answered as JSON (202 when only notifications); `initialize` opens a session whose id
comes back in `Mcp-Session-Id` and must accompany every later request (missing → 400, unknown → 404, so the client initializes
again); DELETE ends it; a session unused for 30 minutes is dropped; other methods → 405. A Host other than 127.0.0.1 / localhost /
[::1], or an Origin that is not one of them, gets 403 (DNS rebinding and web pages). And a named pipe `\\.\pipe\daf-writer-<12 hex
of sha256(userData)>` (elsewhere a 0600 Unix socket in `os.tmpdir()`, named in `userData/agent.json` `{version: 1, pipe, pid,
started}`, removed when it stops) in MCP's stdio framing (newline-delimited JSON-RPC 2.0; a line over 64 MiB closes it), one
session per connection. `bin/daf-agent.js` (stdlib only) relays a client's stdin and stdout to that pipe (`--pipe=<path>`, else
`agent.json` in `DAF_WRITER_USERDATA` or the default userData), answering every request with an error while the app does not listen;
Settings shows it as the app's own executable with `ELECTRON_RUN_AS_NODE=1` (package.json `build.asarUnpack: bin/**`), so no Node
install is needed. Methods: `initialize` (the client's protocol version when it is one of `MCP_VERSIONS`, else the newest;
`clientInfo.name`, lower-cased to `[a-z0-9_-]` and at most 32 characters, `assistant` → `assistant-mcp`, names the session),
`ping`, `tools/list`, `tools/call`, `notifications/cancelled` (a closed connection or HTTP request cancels its own calls too). The
tools are every `headless` command in the model form (Tool schemas above); a call runs `invoke` with source `agent:<name>` in the
main window, so the `agent:*` policy applies (writes run; destructive and approval commands ask on every call). Main forwards on
`agent.event` `{type: call, rid, req}` | `{type: cancel, rid}` | `{type: connected | disconnected, id, name, since}`; the renderer
(`commands.js` `listenGateway`) answers with `agent.reply (rid, result)` (JSON only) after `agent.ready`, before which calls wait
in main. A result is text with its JSON (without `ok` and `ms`); `ok: false` sets `isError` with the error JSON; a `png` field
becomes `image` content. Sessions show in the status bar's agents slot with Disconnect (`agent.disconnect (id)`). No
authentication: any local program can connect while the setting is on.

---------------------------------------------------------------------------------------------------
## 7b. UI implementation: React + shadcn/ui

The whole UI layer is React 19 with shadcn/ui components (Radix primitives, Tailwind CSS v4, lucide-react icons). The behaviour
described in §7, §6b and §6c stays; this section fixes how it is built. Where §2 or §7 name the old plain-DOM implementation
(renderer.js, style.css, `openModal`, `confirm()` / `alert()`), this section wins and those sentences get rewritten.

Stack and build:
- Dependencies: react, react-dom, tailwindcss + @tailwindcss/cli (v4) and what the shadcn/ui components need (radix-ui,
  class-variance-authority, cn — shadcn's class merger, which the registry components import in place of clsx + tailwind-merge —
  lucide-react, tw-animate-css, sonner, cmdk, react-day-picker for the Calendar). No other UI library, no CSS-in-JS, no state
  library. JavaScript only (.js / .jsx): no TypeScript toolchain.
- shadcn components are added with the shadcn CLI (`components.json`: `tsx: false`, CSS variables, neutral base colour) into
  `src/components/ui/`; alias `@/` → `src/` (`jsconfig.json` paths, read by esbuild and the CLI). Never hand-write a component the
  CLI provides. The CLI cannot `init` a project without a framework, so the theme variables in `src/app.css` follow shadcn's
  manual installation (neutral, dark only).
- `npm run build`: esbuild bundles `src/main.jsx` → `dist/renderer.js` (IIFE, automatic JSX runtime, production mode) and the
  Tailwind CLI compiles `src/app.css` → `dist/app.css`, scanning only `src/` and `index.html`. The whole build takes a few seconds
  at most (launch.vbs builds on every start). index.html loads `dist/app.css` and `dist/renderer.js`. CSP unchanged: no external
  resources, no web fonts (system-ui font stack).

Structure:
- `src/main.jsx`: createRoot + `<App/>` (`src/app/App.jsx`), rendered synchronously, then `start()` from actions.js.
- `src/app/store.js`: one plain store (`getState`, `setState(patch | fn)`, `subscribe`, `useStore(selector)` on
  useSyncExternalStore) holding the shell state (settings, drafts, current draft, save status, login status, UI
  flags). The TipTap `Editor` instance lives outside React state; a hook (`useEditor()`) re-renders toolbar state on `transaction` /
  `selectionUpdate`.
- `src/app/actions.js`: the existing logic as plain async functions over the store (settings, autosave / saveNow, drafts open /
  new / delete / unpush, threads discover / add / remove / select, login, push, zoom, global shortcuts, beforeunload, `__smoke`).
  The logic moves over unchanged; only DOM rendering is replaced.
- `src/app/components/*.jsx`: Sidebar (account, threads, drafts), Toolbar, StatusBar, EditorPage (page preview wrapper; mounts
  the TipTap editor into a ref), SettingsDialog (+ preset manager), LinkDialog, thread dialogs, PushOverlay, ConfirmDialog.
- `src/app/components/board/*.jsx`: the §6c chrome (`BoardRail`, flyouts, `ItemRibbon`) and the §6b chrome (the document
  canvas bar and the edit mode bar, `CanvasBar.jsx`). The Board surface itself (items, gestures, snapping, item rendering, rasterizer)
  stays imperative in src/whiteboard.js; it exposes `subscribe(fn)` / `getSnapshot()` and action methods, and a module-level
  active-board store tells the rail and ribbon which board they serve. `<BoardRail/>` and `<ItemRibbon/>` are mounted
  once in App and follow the active board (also a canvas being edited). `<CanvasBar/>` and `<CanvasEditBar/>` are mounted once
  in App and follow the `activeCanvas` / `canvasEditor` stores of src/canvas.js, which keeps the canvas logic (NodeView, edit
  mode, artboard). The ribbon's placement is a pure function (`board/place.mjs`, unit tested): `placeRibbon(box, size, view, avoid,
  at)` takes the selection's chrome box and the handle rects that `ItemRibbon` reads from the board's drawn selection
  decorations (`.wb-sel` items, their handle children, the group box), the bars to avoid and the ribbon's left edge (after a
  pointer selection at the pointer, with the pointer's y; after a keyboard selection at the item's).
- `src/page.css`: the forum page preview typography of §1 / §7 scoped under `.page .ProseMirror` (the board surface CSS is injected
  by src/whiteboard.js).
  Tailwind's preflight must not change the preview: the page area of the smoke sample document renders pixel-identical before and
  after the migration (acceptance test). page.css rolls the base layer back inside `.page` (`all: revert-layer` in `@layer base`),
  so presentational hints and browser defaults apply there, also to the board surfaces (whiteboards and a canvas being edited,
  which is drawn inside `.page`).

Components and look:
- App chrome is always dark (class `dark` on `<html>`), neutral palette, independent of the page preview theme (`data-theme`).
  Interface text is #f5f5f5 (foreground tokens), softer than pure white; the page preview keeps the forum's own colours.
  Scrollbars are themed everywhere: thin (10 px) rounded grey thumb, no arrow buttons, no track (Radix ScrollArea keeps its own).
  Tooltips are 80 % opaque, never take a click (it lands on what is under them) and close as soon as the pointer leaves their
  trigger (hovering a tooltip does not keep it open).
  An open select, menu or popover never swallows a click elsewhere: that click closes it and also acts on what is under the
  pointer (another select opens, a button works); on a board it only closes it (§6c Dismiss-only clicks). Modal dialogs keep their overlay.
  Popovers, like menus and selects, never run out of the window: they are capped at the room on the side they open
  (`--radix-popover-content-available-height`, the title strip counting as outside) and scroll inside when taller.
- UI copy (2026-10-08, the user's plain rules, as for the assistant §7i Writing rules): keyboard characters only. A label that
  opens a dialog and a busy line end in "..." ("Delete...", "Saving..."), shortcuts name their keys ("Alt+Left"), ranges read
  "1 to 12" (dates "5-7 Oct"), sizes "3x3" and "1200 x 675", angles "90 degrees"; separators are a comma, a semicolon or " / "
  (a thread "Subject / Title"); an empty cell shows "-"; the milestone mark and the "no colour" swatch are icons. Language
  names in the dictation list keep their own scripts. Quoted labels elsewhere in this spec may still show the older "…".
- Density: this is a compact workflow tool, not a web page. Root font-size is 13 px (`html` in src/app.css) and every chrome size
  is rem, so text, padding and control heights scale from that one value. UI text is `text-sm` / `text-xs` (never larger than
  `text-base`, and that only for a dialog title). Controls are the small sizes (toolbar and rail buttons about 26 px high). Cards
  and panels use tight padding (`p-2`, at most `p-3`); gaps are `gap-1` / `gap-2`; list rows are single-line where the content
  allows. Nothing is clipped or cut off at the default window size (1600 × 1000) or at 1280 × 720.
- Buttons, toggles, selects, dropdown menus, popovers, dialogs, tooltips, separators, inputs, labels, checkboxes, switches, cards,
  scroll areas, badges and toasts are the shadcn components (Button, Toggle, ToggleGroup, Select, DropdownMenu, Popover, Dialog,
  AlertDialog, Tooltip, Separator, Input, Label, Checkbox, Switch, Card, ScrollArea, Badge, Sonner, Calendar). Colour pickers are
  native `<input type="color">` styled as swatches.
- Toolbar and rail buttons are lucide icons with Tooltips (action + shortcut); text labels only where an icon would be unclear.
  The sidebar is flat, not cards: its sections (account row, Post, Threads, Drafts) sit directly on the sidebar background,
  separated by a thin full-width separator and a small uppercase section header, with the same tight padding; drafts and threads
  are rows with hover actions; "pushed" is a green circle tick.
- No native `confirm()` / `alert()` / `prompt()` in the renderer: confirmations go through a promise helper
  `confirmDialog({title, description, confirmText, destructive})` (AlertDialog); messages are toasts or an AlertDialog.
  The main-process close dialog stays native.
- Toolbar controls never lose the editor selection: after a menu, select or popover closes, focus is back in the editor with the
  selection intact. Board chrome never ends a text-item edit: focus moving into the rail, a flyout, the ribbon or their popups keeps
  the edit open, and the caret returns to the text after a change.
- Every §7 shortcut still works. `window.__smoke` keeps its output shape.
