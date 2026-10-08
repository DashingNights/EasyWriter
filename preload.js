'use strict';
const { contextBridge, ipcRenderer } = require('electron');

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
    remove: call('drafts.remove'),
    loadHistory: call('drafts.loadHistory'),
    saveHistory: call('drafts.saveHistory'),
  },
  plans: { list: call('plans.list'), load: call('plans.load'), save: call('plans.save'), remove: call('plans.remove') },
  flows: { list: call('flows.list'), load: call('flows.load'), save: call('flows.save'), remove: call('flows.remove') },
  prefabs: { list: call('prefabs.list'), load: call('prefabs.load'), save: call('prefabs.save'), remove: call('prefabs.remove') },
  forum: {
    status: call('forum.status'),
    login: call('forum.login'),
    discover: call('forum.discover'),
    describe: call('forum.describe'),
    push: call('forum.push'),
    open: call('forum.open'),
  },
  window: {
    zoom: call('window.zoom'),
    titleBar: call('window.titleBar'),
    capture: call('window.capture'),
  },
  dictation: {
    status: call('dictation.status'),
    install: call('dictation.install'),
    cancel: call('dictation.cancel'),
    warm: call('dictation.warm'),
    transcribe: call('dictation.transcribe'),
    listModels: call('dictation.listModels'),
    deleteModel: call('dictation.deleteModel'),
    /** Install progress events; returns the unsubscribe function. */
    onProgress: (fn) => {
      const listener = (_e, p) => fn(p);
      ipcRenderer.on('dictation.progress', listener);
      return () => ipcRenderer.off('dictation.progress', listener);
    },
  },
  assistant: {
    status: call('assistant.status'),
    install: call('assistant.install'),
    cancel: call('assistant.cancel'),
    warm: call('assistant.warm'),
    stop: call('assistant.stop'),
    delete: call('assistant.delete'),
    deleteLeftover: call('assistant.deleteLeftover'),
    chat: call('assistant.chat'),
    cancelChat: call('assistant.cancelChat'),
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
  // Self-update: `update.ready` (version) once an update has downloaded; install() quits and runs the installer.
  update: {
    install: call('update.install'),
    onReady: (fn) => {
      const listener = (_e, version) => fn(version);
      ipcRenderer.on('update.ready', listener);
      return () => ipcRenderer.off('update.ready', listener);
    },
  },
});
