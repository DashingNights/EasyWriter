'use strict';
const { contextBridge, ipcRenderer, webFrame } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  settings: {
    get: call('settings.get'),
    set: call('settings.set'),
  },
  drafts: {
    list: call('drafts.list'),
    load: call('drafts.load'),
    save: call('drafts.save'),
    savePart: call('drafts.savePart'),
    remove: call('drafts.remove'),
    loadHistory: call('drafts.loadHistory'),
    saveHistory: call('drafts.saveHistory'),
    saveHistoryPart: call('drafts.saveHistoryPart'),
    loadLayout: call('drafts.loadLayout'),
    saveLayout: call('drafts.saveLayout'),
  },
  plans: { list: call('plans.list'), load: call('plans.load'), save: call('plans.save'), remove: call('plans.remove') },
  flows: { list: call('flows.list'), load: call('flows.load'), save: call('flows.save'), remove: call('flows.remove') },
  prefabs: { list: call('prefabs.list'), load: call('prefabs.load'), save: call('prefabs.save'), remove: call('prefabs.remove') },
  forum: {
    status: call('forum.status'),
    login: call('forum.login'),
    describe: call('forum.describe'),
    push: call('forum.push'),
    open: call('forum.open'),
    posts: call('forum.posts'), // the import (docs/plans/onboarding.md Forum import): the member's own posts of topic URLs
    download: call('forum.download'), // one picture or video of an imported post, with the forum's sign-in → {type, data}
  },
  references: { fetch: call('references.fetch') }, // {url, accept}: one GET for a source's details (docs/wiki/references.md)
  window: {
    zoom: call('window.zoom'),
    titleBar: call('window.titleBar'),
    capture: call('window.capture'),
    /** The Mac menu's Settings… (Cmd+,, main.js macMenu); returns the unsubscribe function. */
    onSettings: (fn) => {
      const listener = () => fn();
      ipcRenderer.on('app.settings', listener);
      return () => ipcRenderer.off('app.settings', listener);
    },
  },
  // The main window's right-click: `editMenu.open` {misspelledWord, suggestions, linkURL, editFlags} for each; act(action) with
  // native | learn | copyLink | cut | copy | paste | pasteAndMatchStyle | selectAll. onOpen returns the unsubscribe function.
  editMenu: {
    act: call('editMenu.act'),
    onOpen: (fn) => {
      const listener = (_e, p) => fn(p);
      ipcRenderer.on('editMenu.open', listener);
      return () => ipcRenderer.off('editMenu.open', listener);
    },
  },
  dictation: {
    status: call('dictation.status'),
    install: call('dictation.install'),
    cancel: call('dictation.cancel'),
    warm: call('dictation.warm'),
    transcribe: call('dictation.transcribe'),
    listModels: call('dictation.listModels'),
    deleteModel: call('dictation.deleteModel'),
    system: call('dictation.system'), // 'start' | 'stop': macOS Dictation (Mac only)
    /** Install progress events; returns the unsubscribe function. */
    onProgress: (fn) => {
      const listener = (_e, p) => fn(p);
      ipcRenderer.on('dictation.progress', listener);
      return () => ipcRenderer.off('dictation.progress', listener);
    },
  },
  assistant: {
    status: call('assistant.status'),
    chat: call('assistant.chat'),
    cancelChat: call('assistant.cancelChat'),
    cliRun: call('assistant.cliRun'), // {rid, prompt, system, session}: one Claude Code or Codex turn (SPEC §7i Coding CLIs)
    cliTest: call('assistant.cliTest'), // the dialog's fields → {ok, tools, reply, code, message}
    checkKey: call('assistant.checkKey'), // {provider, key} → {ok, message}: the provider's models list, no tokens spent
    writingGuide: call('assistant.writingGuide'), // the text of EasyWriter's writing guide (src/assistant/human-writing.md)
    /** Install progress, server status and chat stream events (`assistant.event`); returns the unsubscribe function. */
    onEvent: (fn) => {
      const listener = (_e, p) => fn(p);
      ipcRenderer.on('assistant.event', listener);
      return () => ipcRenderer.off('assistant.event', listener);
    },
  },
  // Computer use (SPEC §7i): screenshots and input for this window or the background window, which works on one draft offscreen.
  // The in-app browser (SPEC §7j): the pages' events (`browser.event` {type: open, url} | {type: key, code, control, alt}).
  browser: {
    chromeSignIn: call('browser.chromeSignIn'),
    onEvent: (fn) => {
      const listener = (_e, p) => fn(p);
      ipcRenderer.on('browser.event', listener);
      return () => ipcRenderer.off('browser.event', listener);
    },
  },
  // Globe+Tab and Globe+Space on a Mac (SPEC §7k, main.js watchGlobe): `key.globe` {code: Tab | Space, shift, ctrl, alt, meta, repeat}.
  keys: {
    onGlobe: (fn) => {
      const listener = (_e, p) => fn(p);
      ipcRenderer.on('key.globe', listener);
      return () => ipcRenderer.off('key.globe', listener);
    },
  },
  // Local AI agents (SPEC §8 Agents): the gateway's calls run in the executor (commands.js); `agent.event` {type: call, rid,
  // req} | {type: cancel, rid} | {type: connected | disconnected, id, name, since}.
  agent: {
    ready: () => ipcRenderer.send('agent.ready'),
    reply: (rid, result) => ipcRenderer.send('agent.reply', rid, result),
    disconnect: call('agent.disconnect'),
    status: call('agent.status'), // {on, port, url, error, stdio: {command, args, env}} for Settings
    onEvent: (fn) => {
      const listener = (_e, p) => fn(p);
      ipcRenderer.on('agent.event', listener);
      return () => ipcRenderer.off('agent.event', listener);
    },
  },
  computer: {
    act: call('computer.act'),
    open: call('computer.open'),
    close: call('computer.close'),
    pane: call('computer.pane'),
    /** The background window's events (`computer.event` {type: worker | saved | frame}); returns the unsubscribe function. */
    onEvent: (fn) => {
      const listener = (_e, p) => fn(p);
      ipcRenderer.on('computer.event', listener);
      return () => ipcRenderer.off('computer.event', listener);
    },
  },
  // GitHub backup (SPEC §4b): login() starts the device flow → {userCode, uri}, loginWait() resolves with the status once the
  // user entered the code; `github.event` carries the status {busy, lastSync, error, login, configured, enabled, repo}.
  github: {
    status: call('github.status'),
    login: call('github.login'),
    loginWait: call('github.loginWait'),
    logout: call('github.logout'),
    repos: call('github.repos'),
    checkRepo: call('github.checkRepo'),
    syncNow: call('github.syncNow'),
    start: call('github.start'),
    onEvent: (fn) => {
      const listener = (_e, p) => fn(p);
      ipcRenderer.on('github.event', listener);
      return () => ipcRenderer.off('github.event', listener);
    },
  },
  // Word parity (docs/plans/word plan.md §1.17). print → {ok, error}; printToPDF → base64; saveFile({name, data, filters, as}) writes
  // text for text files and base64 otherwise unless `as` ('text' | 'base64') says; openFile({filters, as}) → {name, data} or null;
  // spell.misspelled and spell.suggest answer at once from the renderer's checker, languages() → {current, available}.
  word: {
    print: call('word.print'),
    printPdf: call('word.printPdf'), // (bytes, word.print's options): the engine's print job → {ok, error}
    printToPDF: call('word.printToPDF'),
    printers: call('word.printers'),
    saveFile: call('word.saveFile'),
    openFile: call('word.openFile'),
    captureSources: call('word.captureSources'),
    metafiles: call('word.metafiles'),
    spell: {
      misspelled: (word) => webFrame.isWordMisspelled(String(word)),
      suggest: (word) => webFrame.getWordSuggestions(String(word)),
      languages: call('word.spell.languages'),
      setLanguages: call('word.spell.setLanguages'),
      add: call('word.spell.add'),
    },
    clipboard: { read: call('word.clipboard.read'), write: call('word.clipboard.write') },
    store: { get: call('word.store.get'), set: call('word.store.set') },
    region: call('word.region'),
    userName: call('word.userName'), // the OS account's name
    versions: call('word.versions'),
    versionAt: call('word.versionAt'),
  },
  // The installed fonts for the canvas engine (electron/fonts-main.js): families() → {families, files, ms}; family(name) →
  // [{name, source}], the files of an installed family (system, per-user or Office's cloud fonts); file(family, name) → the
  // bytes of one of them, or null.
  fonts: { families: call('fonts.families'), family: call('fonts.family'), file: call('fonts.file') },
  // Self-update: `update.event` {type: available|progress|ready, version, percent}; download() resolves once the update is
  // ready; install() quits and runs the installer. onEvent first replays the last offer or ready event sent before it.
  update: {
    version: call('app.version'), // this copy's version (package.json, also in the dev build)
    download: call('update.download'),
    install: call('update.install'),
    onEvent: (fn) => {
      const listener = (_e, ev) => fn(ev);
      ipcRenderer.on('update.event', listener);
      ipcRenderer.invoke('update.last').then((ev) => ev && fn(ev), () => {});
      return () => ipcRenderer.off('update.event', listener);
    },
  },
});

// Document text focus and the Word chords (docs/plans/word plan.md §1.13, §1.17): WordKeys reports them, so main leaves the
// developer tools chord to the editor while it is one of those chords.
contextBridge.exposeInMainWorld('docText', (on, chords) => ipcRenderer.send('word.docText', !!on, Array.isArray(chords) ? chords.map(String) : []));
