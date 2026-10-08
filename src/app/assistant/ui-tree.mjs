// Application control, the pure half (SPEC §8 ui.snapshot / ui.invoke; automation plan §13.11; assistant-coverage §4).
// ui-control.js walks the DOM into records {ref, tag, type, autocomplete, inside, role, name, in?, state, value, risk, area, bounds}
// (`in`: the list row a row action belongs to);
// this file decides which records are never listed or pressed (denyReason), which ask on the approval card every time (riskOf),
// cuts the list into pages (snapshotPage) and says what an action changed (changes). Refs come from createRefs: one per live
// node, the same while the node lives. Import-free (node --test: test/ui-tree.test.mjs).

// The keys ui.invoke may send: no modifiers, so no shortcut (Ctrl+Z, Ctrl+S) can be sent.
export const KEYS = ['Enter', 'Escape', 'Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete', 'Home', 'End'];
export const TEXT_TYPES = ['text', 'search', 'url', 'email', 'number', 'tel'];
export const PAGE_TOKENS = 3000; // one snapshot page, estimated as characters / 3 (automation plan §13.8)
export const estimateTokens = (v) => Math.ceil(JSON.stringify(v).length / 3);

// `inside` (the nearest marked root, ui-control.js INSIDE) of a record that is never listed or pressed.
const DENY_INSIDE = {
  assistant: 'part of the assistant panel',
  ask: 'part of the approval card',
  titlebar: 'part of the title bar',
  editor: 'inside the document or a board (use the doc and board tools)',
  marked: 'kept from the assistant',
};

/** Why record `r` is never listed or pressed, or null: password fields (never their values), file pickers, undo and redo
 * controls, and everything inside the assistant panel, the approval card, the title bar, the editor or a board, or under
 * data-agent-deny. */
export function denyReason(r) {
  if ((r.tag === 'input' && r.type === 'password') || /password/i.test(r.autocomplete ?? '')) return 'a password field';
  if (r.tag === 'input' && r.type === 'file') return 'a file picker';
  // As history.undo / history.redo are never offered (loop.js NEVER): the model must not undo the user's own work.
  if (/^(undo|redo)\b/i.test(r.name ?? '')) return 'an undo or redo control (each step line has its own Undo)';
  return DENY_INSIDE[r.inside] ?? null;
}

// Name rules for controls without data-agent-risk.
const DESTRUCTIVE = /\b(delete|remove|discard|trash|erase|wipe|clear all|uninstall|reset)\b/i;
const APPROVAL = /\b(push|unpush|publish|send|submit|log ?in|sign ?in|log ?out|sign ?out|install|download)\b/i;

/** 'destructive' | 'approval' (the approval card on every call) | 'write': the control's data-agent-risk, else its name. */
export function riskOf(r) {
  if (r.risk === 'destructive' || r.risk === 'approval') return r.risk;
  if (DESTRUCTIVE.test(r.name)) return 'destructive';
  if (APPROVAL.test(r.name)) return 'approval';
  return 'write';
}

/** Whether element facts {tag, type} name a text field: a text input or a textarea. */
export const textField = ({ tag, type }) => (tag === 'input' && TEXT_TYPES.includes(type)) || tag === 'textarea';

/** Why ui.invoke may not send `key` to element {tag, type, editable}, or null: Delete and Backspace go only to a text field or
 * contenteditable (a list's key handler could delete its selected row, such as a Gantt dependency). */
export const keyRefusal = (key, el) => ((key === 'Delete' || key === 'Backspace') && !textField(el) && !el.editable
  ? `${key} goes only to a text field` : null);

/** The model's form of record `r`: empty fields left out. */
const nodeOf = (r) => {
  const risk = riskOf(r);
  return {
    ref: r.ref, role: r.role, name: r.name, ...(r.in && { in: r.in }), ...(r.state?.length && { state: r.state }), ...(r.value !== undefined && { value: r.value }),
    ...(risk !== 'write' && { risk }), bounds: r.bounds,
  };
};

const inScope = { dialog: (a) => a === 'dialog', menu: (a) => a === 'menu', view: (a) => a !== 'dialog' && a !== 'menu' };

/** Page `page` (from 1) of the listable records (document order) → {page, pages, total, groups: [{area, nodes}]}: dialogs first,
 * then menus, then the other areas in the order they first appear; `scope` keeps one of 'dialog' | 'menu' | 'view' (the rest);
 * `query` keeps the records whose role and name hold every word (case-insensitive). A page takes whole nodes while it stays
 * under `budget` tokens; `total` counts every kept record. A page past the last → no groups. */
export function snapshotPage(records, { scope, query, page = 1, budget = PAGE_TOKENS } = {}) {
  const words = query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const kept = records.filter((r) => !denyReason(r) && (!scope || inScope[scope](r.area))
    && words.every((w) => `${r.role} ${r.name}`.toLowerCase().includes(w)));
  const first = new Map();
  kept.forEach((r, i) => first.has(r.area) || first.set(r.area, i));
  const rank = (a) => (a === 'dialog' ? 0 : a === 'menu' ? 1 : 2);
  const order = kept.map((r, i) => ({ r, i })).sort((x, y) => rank(x.r.area) - rank(y.r.area) || first.get(x.r.area) - first.get(y.r.area) || x.i - y.i);
  const pages = [[]];
  let size = 0;
  for (const { r } of order) {
    const n = nodeOf(r);
    const s = JSON.stringify(n).length + r.area.length + 30; // the node, and its share of a group's wrapper
    if (size + s > budget * 3 && pages.at(-1).length) {
      pages.push([]);
      size = 0;
    }
    pages.at(-1).push(n);
    n.area = r.area;
    size += s;
  }
  const groups = new Map();
  for (const { area, ...n } of pages[page - 1] ?? []) {
    if (!groups.has(area)) groups.set(area, []);
    groups.get(area).push(n);
  }
  return { page, pages: kept.length ? pages.length : 0, total: kept.length, groups: [...groups].map(([area, nodes]) => ({ area, nodes })) };
}

/** Refs `e1`, `e2`, … for nodes: the same ref for the same node while it lives (a WeakMap; nothing is written to the node). */
export function createRefs() {
  const ids = new WeakMap();
  const nodes = new Map();
  let n = 0;
  return {
    of(node) {
      let ref = ids.get(node);
      if (!ref) {
        ref = `e${++n}`;
        ids.set(node, ref);
      }
      if (!nodes.has(ref)) nodes.set(ref, new WeakRef(node)); // new, or swept while detached and now back
      return ref;
    },
    /** The live node of `ref`, or null. */
    get: (ref) => nodes.get(ref)?.deref() ?? null,
    /** Forgets the refs of collected nodes and of those `alive` rejects (the DOM side: detached ones). */
    sweep(alive = () => true) {
      for (const [ref, w] of nodes) {
        const node = w.deref();
        if (!node || !alive(node)) nodes.delete(ref);
      }
    },
  };
}

/** What an action changed, from two observations {focus, dialog, menu, target: {name, value, state} | null, notices: []}:
 * {focus?, dialog?, menu? (null: closed), gone?, name?, value?, state?, notices?}; {} when nothing visible changed. */
export function changes(before, after) {
  const out = {};
  for (const k of ['focus', 'dialog', 'menu']) if (after[k] !== before[k]) out[k] = after[k];
  if (before.target && !after.target) out.gone = true;
  else if (before.target && after.target) {
    for (const k of ['name', 'value', 'state']) if (after.target[k] !== before.target[k]) out[k] = after.target[k];
  }
  const fresh = after.notices.filter((t) => !before.notices.includes(t));
  if (fresh.length) out.notices = fresh;
  return out;
}
