<!-- The pictures in docs/img come from `npm run readme-art` (scripts/readme-art.js). Run it again when the app's look changes.
     The download links name no version: every release has EasyWriter-Setup.exe and EasyWriter-Portable.zip. -->

<p align="center">
  <img src="docs/img/banner.webp" width="100%" alt="EasyWriter. Write, draw and plan your project in one app.">
</p>

<p align="center">
  <a href="https://github.com/DashingNights/EasyWriter/releases/latest/download/EasyWriter-Setup.exe"><img src="docs/img/download-installer.webp" height="56" alt="Download for Windows (installer)"></a>&nbsp;&nbsp;<a href="https://github.com/DashingNights/EasyWriter/releases/latest/download/EasyWriter-Portable.zip"><img src="docs/img/download-portable.webp" height="56" alt="Download the portable version (no install needed)"></a>
</p>

<p align="center">
  <a href="https://github.com/DashingNights/EasyWriter/releases/latest"><img src="https://img.shields.io/github/v/release/DashingNights/EasyWriter?label=latest&color=2563eb" alt="Latest version"></a><br>
  Free, for Windows 10 and 11. It keeps itself up to date.<br>
  <a href="https://github.com/DashingNights/EasyWriter/releases/latest">What's new</a> · <a href="#good-to-know">Installer or portable?</a>
</p>

EasyWriter is a Windows app for writing up your projects. Forum posts and documents hold canvases, flowcharts and plan charts next to their text, and an AI assistant can help anywhere in the app.

<p><img src="docs/img/feature-forum.webp" width="100%" alt="Forum posts: write them with the forum's own tools, such as boxes, tables, pictures and canvases, then push the post into your thread's reply box."></p>
<p><img src="docs/img/feature-documents.webp" width="100%" alt="Documents: a page view and a ribbon of tools, as in a word processor, with a reference list in Harvard or IEEE."></p>
<p><img src="docs/img/feature-assistant.webp" width="100%" alt="Assistant: asked to fix the grammar in a document, circle part of a map and start a checklist, it suggests the fixes in the text, adds notes to the map as suggestions and creates the checklist as a new draft. It works with the major AI providers."></p>
<p><img src="docs/img/feature-canvas.webp" width="100%" alt="Canvas: paste a screenshot and mark it up with shapes, arrows and notes, inside your draft."></p>
<p><img src="docs/img/feature-flow.webp" width="100%" alt="Flowcharts: move a box and its arrows follow. Flowcharts are kept in a library and can go into any draft."></p>
<p><img src="docs/img/feature-plan.webp" width="100%" alt="Plan: a Kanban board, a backlog and a Gantt chart for every project, with your drafts on the cards."></p>
<p><img src="docs/img/feature-more.webp" width="100%" alt="Also inside: a browser with tabs, dictation that runs on your PC, themes, GitHub backup, a quick access menu and a portable version. More features are coming soon."></p>

## Good to know

<details>
<summary><b>Installer or portable?</b></summary>

Take the installer if you can install apps on your PC. Run `EasyWriter-Setup.exe` and follow the steps.

Take the portable version on a PC that blocks installers, such as a school computer. Extract `EasyWriter-Portable.zip` anywhere you can save files, such as the Desktop or a USB stick, and run `EasyWriter.exe` inside it.
</details>

<details>
<summary><b>Windows says it protected your PC</b></summary>

EasyWriter is not code-signed, so Windows SmartScreen may stop it the first time it runs. Click **More info**, then **Run anyway**.
</details>

<details>
<summary><b>The download is blocked</b></summary>

Some school networks block downloads in the browser. Make an empty folder, type `cmd` in the address bar of File Explorer in that folder and press Enter, then run this line. It downloads the portable version and extracts it there.

```
curl.exe -L -o EasyWriter.zip https://github.com/DashingNights/EasyWriter/releases/latest/download/EasyWriter-Portable.zip && tar -xf EasyWriter.zip
```
</details>

<details>
<summary><b>Updates</b></summary>

Both versions check for a new version and download it in the background. When it is ready, EasyWriter shows a Restart button, and it saves your open draft before it restarts. The [releases page](https://github.com/DashingNights/EasyWriter/releases) lists what changed in each version.
</details>

<details>
<summary><b>Where your work is saved</b></summary>

The installed version keeps everything in `%APPDATA%\EasyWriter`. The portable version keeps everything in the `data` folder next to `EasyWriter.exe`, so take that folder with you when you move the app.

For a copy somewhere else, turn on GitHub backup. Your drafts, plans and flowcharts then go to a private repository of your own.
</details>

<details>
<summary><b>Which AI providers the assistant works with</b></summary>

ChatGPT and Claude through Codex and Claude Code, or Google Gemini, DeepSeek and Qwen with your own API key. Pick one in Settings. The assistant stays off until you do, and its edits wait as suggestions unless you let it apply them straight away.
</details>

<details>
<summary><b>Which forums it works with</b></summary>

Invision Community forums. Turn the forum integration on in Settings, link a project to your thread, and Push fills the thread's reply box with your draft, canvases as pictures. You press Submit on the forum yourself.
</details>

## Build from source

You need Windows and Node.js 22 or newer.

```
npm install
npm start
```

`npm start` builds the app and opens it. `npm run dist` builds the installer and the portable zip into the `release` folder.

## Licence

The source is published so that you can read and review it. It is not open source, and you may not copy, change or redistribute it without written permission. You may download the official release builds and run them for your own use. See [LICENSE](LICENSE).
