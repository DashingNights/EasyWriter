// The board's undo across sessions (docs/plans/board/design.md section 7, briefs/bd-journal.md): board steps and document
// steps in the order they were made, heard from the store and from each instance session's layout event. An entry runs only
// when every doc part is still its session's top undo step, and it adds before it removes, so a crash duplicates and never
// loses. A doc part's `step` is the engine's top undo step id; a board part's `step` is the store's step.

const LIMIT = 500;

export class Journal {
  /** `clients(session)` → the session's SessionClient or null; `titleOf(session)` its draft's title; `say(line)` shows a line;
   * `save()` writes the board (the app's saveNow); `saveDoc(session)` writes that document's record (the app's saveOnce);
   * `changed()` hears every change to the stacks, so the chrome's Undo and Redo follow a document step. */
  constructor({ store, clients, titleOf, say, save = async () => true, saveDoc = async () => true, changed = () => {} }) {
    this.store = store;
    this.clients = clients ?? (() => null);
    this.titleOf = titleOf ?? (() => '');
    this.say = say ?? (() => {});
    this.changed = changed;
    this.save = save;
    this.saveDoc = saveDoc;
    this.entries = [];
    this.redos = [];
    this.busy = false;
    this.real = new Map(); // SessionClient → its own {undo, redo}, before the journal took them
    this.watched = new Map(); // session id → SessionClient
    this.seen = new Map(); // session id → the {undo, redo} its layout last reported
    this.sealed = new Set(); // sessions a board step came after: their next step is a new entry
    this.offs = [];
  }

  // --- hearing the changes ---

  /** A board step. Store undo and redo notifications are not new steps: the nudge join undoes its own last step to rebuild it.
   * A step made after a document step seals that session, so letters that later join the open engine step start a new entry. */
  noteBoard(step) {
    if (!step || this.busy) return;
    if (this.store.steps.at(-1) !== step) return;
    for (const [session, seen] of this.seen) {
      if (seen?.undo != null && this.entries.some((entry) => this._holds(entry, session, seen.undo))) this.sealed.add(session);
    }
    this.entries.push({ parts: [{ kind: 'board', step }] });
    this.redos.length = 0;
    this._trim();
    this.changed();
  }

  /** A document step, from its session's layout event. Typed letters keep one id, so a step the top entry holds is skipped. */
  noteDoc(session, step) {
    if (step == null || this.busy) return;
    const top = this.entries.at(-1);
    if (top && this._holds(top, session, step)) return;
    this.entries.push({ parts: [{ kind: 'doc', session, step }] });
    this.redos.length = 0;
    this._trim();
    this.changed();
  }

  /** Parts the caller made as one change: one entry, replacing any entry already standing for one of the parts. */
  group(parts) {
    if (this.busy || !parts?.length) return;
    this.entries = this.entries.filter((entry) => !parts.some((part) => this._holdsPart(entry, part)));
    this.entries.push({ parts: parts.map((part) => ({ ...part })) });
    this.redos.length = 0;
    this._trim();
    this.changed();
  }

  /** The board closes session `session` (its draft left the view, saved): its document steps can no longer run, so their parts
   * go from both stacks. An entry left with no parts goes; one with a board part keeps it (bd-instance's session cap). */
  forget(session) {
    for (const list of [this.entries, this.redos]) {
      const kept = [];
      for (const entry of list) {
        const parts = entry.parts.filter((part) => !(part.kind === 'doc' && part.session === session));
        if (!parts.length) continue;
        entry.parts = parts;
        kept.push(entry);
      }
      list.length = 0;
      list.push(...kept);
    }
    this.sealed.delete(session);
    this.seen.delete(session);
    this.changed();
  }

  /** A doc step undone in another view: its entry goes, and its board part runs so the board keeps the document. */
  docUndone(session, step) {
    if (step == null || this.busy) return;
    const at = this.entries.findIndex((entry) => this._holds(entry, session, step));
    if (at < 0) return;
    const [entry] = this.entries.splice(at, 1);
    this.changed();
    const board = entry.parts.filter((part) => part.kind === 'board');
    if (!board.length) return;
    this.busy = true;
    try {
      for (const part of board) this.store.undo(part.step.id);
    } finally {
      this.busy = false;
    }
  }

  // --- undo and redo ---

  async undo() {
    return this._step('undo');
  }

  async redo() {
    return this._step('redo');
  }

  canUndo() {
    return this.entries.length > 0;
  }

  canRedo() {
    return this.redos.length > 0;
  }

  /** Pops the top entry of `dir`'s list, checks every doc part, then runs the parts that bring content back, saves them, and
   * runs the rest. An entry whose board step another path rebuilt is skipped; a failed save puts the entry back. */
  async _step(dir) {
    if (this.busy) return false;
    const list = dir === 'undo' ? this.entries : this.redos;
    let entry;
    for (;;) {
      entry = list.pop();
      if (!entry) {
        this.changed();
        return false;
      }
      entry.parts = entry.parts.filter((part) => part.kind !== 'board' || this._live(part.step, dir));
      if (entry.parts.length) break;
    }
    if (!await this._valid(entry, dir)) {
      this.changed();
      return false;
    }
    this.busy = true;
    let failed = null;
    let ran = false;
    try {
      const back = entry.parts.filter((part) => this._bringsBack(part, dir));
      const away = entry.parts.filter((part) => !this._bringsBack(part, dir));
      await this._run(back, dir);
      failed = await this._save(back);
      if (!failed) await this._run(away, dir);
    } catch {
      ran = true;
    } finally {
      this.busy = false;
    }
    if (failed || ran) {
      list.push(entry);
      const title = this.titleOf(failed?.session ?? null);
      this.say(ran
        ? `The last change in "${title}" could not be ${dir === 'undo' ? 'undone' : 'redone'}.`
        : `The last change in "${title}" could not be saved, so it was not ${dir === 'undo' ? 'undone' : 'redone'}.`);
      return false;
    }
    (dir === 'undo' ? this.redos : this.entries).push(entry);
    this.changed();
    return true;
  }

  /** Every doc part must still be its session's top step of `dir`; a closed session or a newer step drops the entry. */
  async _valid(entry, dir) {
    for (const part of entry.parts) {
      if (part.kind !== 'doc') continue;
      const client = this._client(part.session);
      const steps = client ? await client.steps().catch(() => null) : null;
      if (!steps || steps[dir] !== part.step) {
        this.say(`The last change in "${this.titleOf(part.session)}" was made somewhere else, so it was not ${dir === 'undo' ? 'undone' : 'redone'}.`);
        return false;
      }
    }
    return true;
  }

  /** Whether `part`'s `dir` brings content back: an undo of a delete does, and so does a redo of a create. A doc part says so
   * for its undo (`adds`, set by bd-dragout); a board part by the step's own gone entries. */
  _bringsBack(part, dir) {
    if (part.kind === 'doc') return dir === 'undo' ? !!part.adds : !part.adds;
    const gone = (part.step.undo ?? []).filter((entry) => entry.f === 'gone').map((entry) => entry.v);
    if (!gone.length) return false;
    return dir === 'undo' ? gone.includes(false) : gone.includes(true);
  }

  /** Runs the parts in order; a document's undo and redo are its client's own, before the journal took them. */
  async _run(parts, dir) {
    for (const part of parts) {
      if (part.kind === 'board') this.store[dir](part.step.id);
      else {
        const client = this._client(part.session);
        const real = this.real.get(client);
        const fn = real ? real[dir] : client?.[dir];
        if (fn) await fn.call(client);
      }
    }
  }

  /** Writes what the first set changed before the second set takes content away → the part whose save failed, or null. A
   * save that answers false or throws is a failure: the removal after it must not run. */
  async _save(parts) {
    if (parts.some((part) => part.kind === 'board')) {
      if (!await this._saved(this.save())) return { kind: 'board' };
    }
    for (const part of parts) {
      if (part.kind !== 'doc') continue;
      if (!await this._saved(this.saveDoc(part.session))) return part;
    }
    return null;
  }

  async _saved(promise) {
    try {
      return !!(await promise);
    } catch {
      return false;
    }
  }

  /** A doc step whose id another view has not seen arrive: the same engine step extended after a board step is a new entry,
   * and the older entry for that one step goes, since one step cannot be undone twice. */
  _freshDoc(session, step) {
    const at = this.entries.findIndex((entry) => entry.parts.length === 1 && this._holds(entry, session, step));
    if (at >= 0) this.entries.splice(at, 1);
    this.entries.push({ parts: [{ kind: 'doc', session, step }] });
    this.redos.length = 0;
    this._trim();
    this.changed();
  }

  // --- the sessions ---

  /** An instance session: its undo and redo go through the journal, and its layout events make its doc steps. Returns the
   * function that takes the watch back off. */
  watch(client) {
    if (!client) return () => {};
    const session = client.id;
    this.watched.set(session, client);
    if (!this.real.has(client)) {
      const real = { undo: client.undo.bind(client), redo: client.redo.bind(client) };
      this.real.set(client, real);
      client.undo = () => this.undo();
      client.redo = () => this.redo();
    }
    const queue = [];
    let baseline; // undefined until the steps at watch time are read: the events before then wait
    const onEvent = (e) => {
      const now = e?.steps;
      if (!now) return;
      if (baseline === undefined) return queue.push(e);
      const before = this.seen.get(session) ?? baseline;
      this.seen.set(session, { undo: now.undo ?? null, redo: now.redo ?? null });
      const sealed = this.sealed.delete(session);
      if (this.busy) return;
      // A step moved to the redo stack was undone in this session's own view; a step back on the undo stack was redone there.
      if (now.redo != null && now.redo === before.undo) this.docUndone(session, now.redo);
      else if (now.undo != null && now.undo === before.redo) this.noteDoc(session, now.undo);
      else if (now.undo != null && now.undo !== before.undo) this.noteDoc(session, now.undo);
      // The same step id after a board step: the open engine step took more letters, and they came after that step.
      else if (sealed && now.undo != null) this._freshDoc(session, now.undo);
    };
    const off = client.on?.('layout', onEvent);
    if (off) this.offs.push(off);
    // A query, never a command: its answer is the session as it was when the watch began, before any later edit.
    const start = (steps) => {
      if (baseline !== undefined) return;
      baseline = { undo: steps?.undo ?? null, redo: steps?.redo ?? null };
      this.seen.set(session, baseline);
      for (const e of queue.splice(0)) onEvent(e);
    };
    client.steps?.().then(start, () => start(null));
    return () => {
      off?.();
      this.offs = this.offs.filter((fn) => fn !== off);
      this.watched.delete(session);
      this.seen.delete(session);
      this.sealed.delete(session);
      const real = this.real.get(client);
      if (real) {
        client.undo = real.undo;
        client.redo = real.redo;
        this.real.delete(client);
      }
    };
  }

  /** The board area is gone: its sessions' layout listeners and overrides go with it. */
  dispose() {
    for (const off of this.offs.splice(0)) off();
    for (const [client, real] of this.real) {
      client.undo = real.undo;
      client.redo = real.redo;
    }
    this.real.clear();
    this.watched.clear();
    this.seen.clear();
    this.sealed.clear();
  }

  _client(session) {
    return this.watched.get(session) ?? this.clients(session) ?? null;
  }

  _holds(entry, session, step) {
    return entry.parts.some((part) => part.kind === 'doc' && part.session === session && part.step === step);
  }

  _holdsPart(entry, part) {
    return entry.parts.some((held) => held.kind === part.kind && (part.kind === 'board'
      ? held.step === part.step
      : held.session === part.session && held.step === part.step));
  }

  _live(step, dir) {
    // By id: the store's own undo and redo push new step objects with the step's id.
    return (dir === 'undo' ? this.store.steps : this.store.redos).some((held) => held.id === step.id);
  }

  _trim() {
    if (this.entries.length > LIMIT) this.entries.splice(0, this.entries.length - LIMIT);
  }
}
