// The board's stored form: field-level last writer wins, one op log, undo and redo.

import { keyAt } from './order.mjs';

export const FORM = 'easywriter.board';
export const VERSION = 1;

const RESERVED = new Set(['form', 'version', 'clock', 'items', 'media', '_s']);

export const blankBoard = () => ({ form: FORM, version: VERSION, clock: 0, items: {}, media: {}, bg: 'canvas', frame: null, _s: {} });

/** 16 chars of base36 from crypto.getRandomValues. */
export function newId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += (b % 36).toString(36);
  return out;
}

/** 'board' (form matches, version <= VERSION), 'newer' (form matches, version above), 'old' (no form). */
export function readForm(v) {
  if (!v || v.form !== FORM) return 'old';
  return (v.version ?? 0) > VERSION ? 'newer' : 'board';
}

/** True when stamp a is greater: clock first, then client by string compare; undefined is [0, '']. */
export function stampAfter(a, b) {
  const [ca, cl] = a ?? [0, ''];
  const [cb, bl] = b ?? [0, ''];
  return ca > cb || (ca === cb && cl > bl);
}

const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const EMPTY_STAMP = [0, ''];

export class BoardStore {
  constructor(board, { client = newId(), limit = 500 } = {}) {
    board.items ??= {};
    board.media ??= {};
    board._s ??= {};
    this.board = board;
    this.client = client;
    this.limit = limit;
    this.log = [];
    this.link = null;
    this.steps = [];
    this.redos = [];
    this.subs = new Set();
    this._record = null;
    this._rebuildIndex();
  }

  get(id) {
    return this.board.items[id];
  }

  /** Live items in paint order: depth first, roots then each group's children, by at[1], ties by id. */
  live() {
    const out = [];
    const walk = (parent) => {
      for (const item of this.children(parent)) {
        out.push(item);
        walk(item.id);
      }
    };
    walk(null);
    return out;
  }

  /** Live items are those with a type; children of a missing or gone parent read as roots. */
  children(parent) {
    const p = parent ?? null;
    const out = [];
    const fixed = this._nested > 0 ? this._cycleFix() : null;
    for (const id of this._kids.get(p) ?? []) {
      if (fixed && fixed.has(id)) continue;
      out.push(this.board.items[id]);
    }
    if (p === null && fixed && fixed.size) {
      for (const id of fixed.keys()) out.push(this.board.items[id]);
      out.sort(byOrder);
    }
    return out;
  }

  orderKey(parent, index, tx) {
    const kids = this.children(parent);
    const { key, rekey } = keyAt(kids.map((k) => k.at?.[1] ?? ''), index);
    for (const [i, k] of rekey) tx.set(kids[i].id, 'at', [parent ?? null, k]);
    return key;
  }

  change(label, fn, { silent = false } = {}) {
    const ops = [];
    const undo = [];
    const mark = this.log.length;
    this._record = [];
    try {
      fn(this._tx(ops, undo));
    } catch (err) {
      this._rollback(this._record);
      this._record = null;
      this.log.length = mark;
      throw err;
    }
    this._record = null;
    if (!ops.length) return null;
    this.link?.send(ops);
    let step = null;
    if (!silent) {
      step = { id: newId(), label, undo };
      this.steps.push(step);
      this._trim();
      this.redos = [];
    }
    this._notify(ops, step);
    return step;
  }

  undo(stepId = null) {
    const at = stepId == null ? this.steps.length - 1 : this.steps.findIndex((s) => s.id === stepId);
    if (at < 0) return null;
    const step = this.steps.splice(at, 1)[0];
    const ops = [];
    const redo = { id: step.id, label: step.label, undo: this._rewrite(step, ops) };
    this.redos.push(redo);
    this.link?.send(ops);
    this._notify(ops, redo);
    return redo;
  }

  redo(stepId = null) {
    const at = stepId == null ? this.redos.length - 1 : this.redos.findIndex((s) => s.id === stepId);
    if (at < 0) return null;
    const step = this.redos.splice(at, 1)[0];
    const ops = [];
    const back = { id: step.id, label: step.label, undo: this._rewrite(step, ops) };
    this.steps.push(back);
    this._trim();
    this.link?.send(ops);
    this._notify(ops, back);
    return back;
  }

  canUndo() {
    return this.steps.length > 0;
  }

  canRedo() {
    return this.redos.length > 0;
  }

  /**
   * Link contract: ops from one client arrive in order with no gaps (a WebSocket or a relay that keeps
   * per-client order). A transport that can lose a message syncs again with deltaSince({}).
   */
  receive(ops) {
    if (!ops?.length) return;
    const applied = [];
    for (const raw of ops) {
      const op = structuredClone(raw);
      this.board.clock = Math.max(this.board.clock, op.s?.[0] ?? 0);
      if (this._apply(op)) {
        this.log.push(op);
        applied.push(op);
      }
    }
    if (applied.length) this._notify(applied, null);
  }

  merge(otherBoard) {
    const other = otherBoard?.board ?? otherBoard;
    if (!other) return;
    const ops = [];
    for (const [id, item] of Object.entries(other.items ?? {})) {
      const stamps = item._s ?? {};
      for (const f of new Set([...Object.keys(item), ...Object.keys(stamps)])) {
        if (f === '_s' || f === 'id') continue;
        ops.push({ i: id, f, v: structuredClone(item[f]), s: stamps[f] ?? EMPTY_STAMP });
      }
    }
    const applied = [];
    for (const op of ops) {
      this.board.clock = Math.max(this.board.clock, op.s[0]);
      if (this._apply(op)) applied.push(op);
    }
    const theirStamps = other._s ?? {};
    for (const f of new Set([...Object.keys(other), ...Object.keys(theirStamps)])) {
      if (RESERVED.has(f)) continue;
      const mine = this.board._s[f];
      const theirs = theirStamps[f];
      if (theirs && stampAfter(theirs, mine)) {
        if (other[f] === undefined) delete this.board[f];
        else this.board[f] = structuredClone(other[f]);
        this.board._s[f] = structuredClone(theirs);
      } else if (!theirs && !mine) {
        this.board[f] = structuredClone(pickValue(this.board[f], other[f]));
      }
    }
    for (const [k, v] of Object.entries(other.media ?? {})) {
      const chosen = pickValue(this.board.media[k], v);
      if (chosen !== undefined) this.board.media[k] = structuredClone(chosen);
    }
    if (applied.length) this._notify(applied, null);
  }

  /** Highest clock seen from each client, read from the stored stamps. */
  seen() {
    const out = {};
    const add = (stamps) => {
      for (const stamp of Object.values(stamps ?? {})) {
        if (!stamp) continue;
        if (stamp[0] > (out[stamp[1]] ?? 0)) out[stamp[1]] = stamp[0];
      }
    };
    add(this.board._s);
    for (const item of Object.values(this.board.items)) add(item._s);
    return out;
  }

  /** Every stored field whose stamp is newer than `seen` already has, as ops that rebuild the state. */
  deltaSince(seen = {}) {
    const ops = [];
    const add = (i, fields, stamps) => {
      for (const [f, s] of Object.entries(stamps ?? {})) {
        if (!s || s[0] <= (seen[s[1]] ?? 0)) continue;
        ops.push({ i, f, v: fields[f], s });
      }
    };
    add(null, this.board, this.board._s);
    for (const [id, item] of Object.entries(this.board.items)) add(id, item, item._s);
    return ops;
  }

  subscribe(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  toJSON() {
    const named = new Set();
    for (const step of [...this.steps, ...this.redos]) for (const e of step.undo) named.add(e.i);
    const items = {};
    for (const [id, item] of Object.entries(this.board.items)) {
      if (item.gone && !named.has(id)) {
        items[id] = { id: item.id, type: item.type, gone: true, _s: { gone: item._s?.gone } };
      } else {
        items[id] = item;
      }
    }
    const used = new Set();
    for (const item of Object.values(items)) {
      if (item.gone) continue;
      if (item.media != null) used.add(item.media);
      if (item.fill?.media != null) used.add(item.fill.media);
    }
    const media = {};
    for (const [k, v] of Object.entries(this.board.media ?? {})) if (used.has(k)) media[k] = v;
    return structuredClone({ ...this.board, items, media });
  }

  _tx(ops, undo) {
    const tx = {
      create: (fields = {}) => {
        if (!fields.type || !Array.isArray(fields.at)) throw new Error('create needs type and at');
        const id = fields.id ?? newId();
        const all = { ...fields, gone: fields.gone ?? false };
        for (const [f, v] of Object.entries(all)) {
          if (f === 'id') continue;
          this._write({ i: id, f, v }, ops);
        }
        undo.push({ i: id, f: 'gone', v: true });
        return id;
      },
      set: (id, field, value) => {
        const old = this.board.items[id]?.[field];
        if (same(old, value)) return;
        undo.push({ i: id, f: field, v: structuredClone(old) });
        this._write({ i: id, f: field, v: value }, ops);
      },
      patch: (id, object) => {
        for (const [f, v] of Object.entries(object)) tx.set(id, f, v);
      },
      board: (field, value) => {
        if (RESERVED.has(field)) return;
        if (same(this.board[field], value)) return;
        undo.push({ i: null, f: field, v: structuredClone(this.board[field]) });
        this._write({ i: null, f: field, v: value }, ops);
      },
      remove: (id) => {
        for (const target of [id, ...this._descendants(id)]) {
          const item = this.board.items[target];
          if (!item || item.gone) continue;
          undo.push({ i: target, f: 'gone', v: item.gone ?? false });
          this._write({ i: target, f: 'gone', v: true }, ops);
        }
      },
    };
    return tx;
  }

  _descendants(id) {
    const out = [];
    const walk = (parent) => {
      for (const child of this.children(parent)) {
        out.push(child.id);
        walk(child.id);
      }
    };
    walk(id);
    return out;
  }

  _write(op, ops) {
    if (this._record) {
      const holder = op.i == null ? this.board : this.board.items[op.i];
      this._record.push({
        i: op.i,
        f: op.f,
        had: holder ? Object.hasOwn(holder, op.f) : false,
        v: holder ? structuredClone(holder[op.f]) : undefined,
        stamp: holder?._s ? structuredClone(holder._s[op.f]) : undefined,
        existed: op.i == null ? true : !!holder,
      });
    }
    this.board.clock += 1;
    const full = { i: op.i, f: op.f, v: structuredClone(op.v), s: [this.board.clock, this.client] };
    this._apply(full);
    this.log.push(full);
    ops.push(full);
    return full;
  }

  /**
   * Writes a step's values in reverse with new stamps and returns the inverse entries, read as each
   * value is overwritten. A revive re-stamps every field, as Figma does: a deleted item's data lives
   * in the deleting client's undo step, so edits another client made while it was deleted are lost.
   */
  _rewrite(step, ops) {
    const undo = [];
    for (const entry of [...step.undo].reverse()) {
      const holder = entry.i == null ? this.board : this.board.items[entry.i];
      if (holder && entry.f === 'gone' && entry.v === false) {
        for (const f of Object.keys(holder)) {
          if (f === 'id' || f === '_s' || f === 'gone') continue;
          undo.push({ i: entry.i, f, v: structuredClone(holder[f]) });
          this._write({ i: entry.i, f, v: holder[f] }, ops);
        }
      }
      undo.push({ i: entry.i, f: entry.f, v: holder ? structuredClone(holder[entry.f]) : undefined });
      this._write({ i: entry.i, f: entry.f, v: entry.v }, ops);
    }
    return undo;
  }

  _apply(op) {
    if (op.i == null) {
      if (RESERVED.has(op.f)) return false;
      const cur = this.board._s[op.f];
      if (cur && !stampAfter(op.s, cur)) return false;
      if (op.v === undefined) delete this.board[op.f];
      else this.board[op.f] = op.v;
      this.board._s[op.f] = op.s;
      return true;
    }
    const items = this.board.items;
    let item = items[op.i];
    if (!item) items[op.i] = item = { id: op.i, _s: {} };
    if (op.f === 'id') return false;
    if (op.f === 'type' && item.type !== undefined) {
      // The type never changes, but its stamp merges so both merge orders agree.
      if (!item._s.type || stampAfter(op.s, item._s.type)) {
        item._s.type = op.s;
        return true;
      }
      return false;
    }
    const cur = item._s[op.f];
    if (cur && !stampAfter(op.s, cur)) return false;
    const reindex = op.f === 'at' || op.f === 'gone';
    if (reindex) this._indexRemove(op.i);
    if (op.v === undefined) delete item[op.f];
    else item[op.f] = op.v;
    item._s[op.f] = op.s;
    if (reindex) {
      this._indexAdd(op.i);
      if (op.f === 'gone') this._rehome(op.i);
    }
    if (!this._where.has(op.i)) this._indexAdd(op.i);
    this._cyclesDirty = true;
    return true;
  }

  _rollback(record) {
    for (let k = record.length - 1; k >= 0; k--) {
      const e = record[k];
      const holder = e.i == null ? this.board : this.board.items[e.i];
      if (holder) {
        if (e.had) holder[e.f] = e.v;
        else delete holder[e.f];
        if (e.stamp) (holder._s ??= {})[e.f] = e.stamp;
        else if (holder._s) delete holder._s[e.f];
      }
      if (!e.existed) delete this.board.items[e.i];
    }
    this._rebuildIndex();
  }

  _rebuildIndex() {
    this._kids = new Map();
    this._where = new Map();
    this._nested = 0;
    this._cycles = null;
    this._cyclesDirty = true;
    for (const id of Object.keys(this.board.items)) this._indexAdd(id);
  }

  _parentOf(item) {
    const p = item.at?.[0] ?? null;
    if (p == null) return null;
    const parent = this.board.items[p];
    return parent && !parent.gone ? p : null;
  }

  _indexAdd(id) {
    const item = this.board.items[id];
    if (!item || item.gone || !item.type || this._where.has(id)) return;
    const parent = this._parentOf(item);
    const key = item.at?.[1] ?? '';
    const list = this._kids.get(parent) ?? [];
    if (parent !== null) this._nested++;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const other = this.board.items[list[mid]];
      const oKey = other.at?.[1] ?? '';
      if (oKey < key || (oKey === key && list[mid] < id)) lo = mid + 1;
      else hi = mid;
    }
    list.splice(lo, 0, id);
    this._kids.set(parent, list);
    this._where.set(id, parent);
    this._cyclesDirty = true;
  }

  _indexRemove(id) {
    if (!this._where.has(id)) return;
    const parent = this._where.get(id);
    if (parent !== null) this._nested--;
    const list = this._kids.get(parent);
    if (list) {
      const at = list.indexOf(id);
      if (at >= 0) list.splice(at, 1);
    }
    this._where.delete(id);
    this._cyclesDirty = true;
  }

  /** A gone or live parent moves its children between the root and itself. */
  _rehome(id) {
    const item = this.board.items[id];
    if (!item) return;
    if (item.gone) {
      for (const child of [...(this._kids.get(id) ?? [])]) {
        this._indexRemove(child);
        this._indexAdd(child);
      }
    } else {
      for (const child of [...(this._kids.get(null) ?? [])]) {
        if (this.board.items[child]?.at?.[0] === id) {
          this._indexRemove(child);
          this._indexAdd(child);
        }
      }
    }
  }

  /** The member of each cycle with the oldest at stamp (ties by id) reads as a root. */
  _cycleFix() {
    if (this._cycles && !this._cyclesDirty) return this._cycles;
    const fix = new Map();
    if (this._nested > 0) {
      const done = new Set();
      for (const start of this._where.keys()) {
        if (done.has(start)) continue;
        const path = [];
        const seen = new Map();
        let cur = start;
        while (cur != null && this._where.has(cur) && !seen.has(cur)) {
          seen.set(cur, path.length);
          path.push(cur);
          cur = this._where.get(cur);
        }
        if (cur != null && seen.has(cur)) {
          const members = path.slice(seen.get(cur));
          let drop = members[0];
          for (const id of members) if (olderAt(this.board.items[id], this.board.items[drop], id, drop)) drop = id;
          fix.set(drop, null);
        }
        for (const id of seen.keys()) done.add(id);
      }
    }
    this._cycles = fix;
    this._cyclesDirty = false;
    return fix;
  }

  _trim() {
    if (this.steps.length > this.limit) this.steps.splice(0, this.steps.length - this.limit);
  }

  _notify(ops, step) {
    if (!this.subs.size) return;
    const ids = new Set(ops.map((op) => op.i));
    for (const fn of [...this.subs]) fn({ ids, ops, step });
  }
}

const byOrder = (a, b) => {
  const ka = a.at?.[1] ?? '';
  const kb = b.at?.[1] ?? '';
  return ka < kb ? -1 : ka > kb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

const olderAt = (a, b, aid, bid) => {
  const sa = a?._s?.at ?? EMPTY_STAMP;
  const sb = b?._s?.at ?? EMPTY_STAMP;
  if (sa[0] !== sb[0]) return sa[0] < sb[0];
  if (sa[1] !== sb[1]) return sa[1] < sb[1];
  return aid < bid;
};

const pickValue = (a, b) => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  return jb > ja ? b : a;
};
