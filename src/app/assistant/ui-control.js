import { fail } from '../commands/define.mjs';
import { changes, createRefs, denyReason, keyRefusal, riskOf, snapshotPage, TEXT_TYPES, textField } from './ui-tree.mjs';

// Application control, the DOM half (SPEC §8 ui.snapshot / ui.invoke; automation plan §13.11; assistant-coverage §4): reads the
// visible controls of this window into records (ui-tree.mjs decides the rest) and acts on one of them with DOM events dispatched
// on that element only: no CDP, no OS input, no coordinates from the model. The forum window and OS dialogs are other windows,
// so nothing here can reach them; ui.invoke refuses while one of them has the focus.

const refs = createRefs();

// What counts as a control; also any element whose own cursor is a pointer (a clickable row).
const CONTROL = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], '
  + '[role=switch], [role=radio], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], '
  + '[role=combobox], [role=slider], [role=spinbutton], [role=treeitem], [tabindex="0"]';
// Marked roots: never listed (the walk skips them) and refused by ui.invoke (denyReason).
const INSIDE = [
  ['#assistant-panel, [data-chat-island]', 'assistant'],
  ['[data-agent-ask]', 'ask'],
  ['[data-titlebar]', 'titlebar'],
  ['.ProseMirror, .wb, [contenteditable="true"]', 'editor'],
  ['[data-agent-deny]', 'marked'],
];
const SKIP = `[inert], [aria-hidden="true"], svg, script, style, template, ${INSIDE.map(([s]) => s).join(', ')}`;
const POPPER = '[data-radix-popper-content-wrapper]';
const RATE = { max: 20, ms: 60000 }; // ui.invoke calls a minute (a turn has at most 8 commands, loop.js)

const clip = (s, n = 60) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
};
const INPUT_ROLES = { checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', button: 'button', submit: 'button', reset: 'button', search: 'searchbox' };

function roleOf(el) {
  const tag = el.localName;
  const role = el.getAttribute('role');
  if (role) return role;
  if (tag === 'a') return 'link';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') return INPUT_ROLES[el.type] ?? 'textbox';
  return el.matches('[tabindex="0"]') && tag !== 'button' && tag !== 'summary' ? 'group' : 'button';
}

function labelOf(el) {
  const label = el.getAttribute('aria-label');
  if (label) return clip(label);
  const by = el.getAttribute('aria-labelledby');
  return by ? clip(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')) : '';
}

/** The text of `el`, its text nodes joined by spaces ("Plans Ctrl+Alt+P", not "PlansCtrl+Alt+P"). */
function textOf(el) {
  const parts = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) parts.push(t.data);
  return parts.join(' ');
}

/** aria-label, aria-labelledby, a <label>, the text (not of a field), title or placeholder; a slider thumb, its slider's label. */
function nameOf(el) {
  const field = ['input', 'select', 'textarea'].includes(el.localName) || el.getAttribute('role') === 'combobox';
  return labelOf(el) || clip(el.labels?.[0]?.textContent) || (!field && clip(textOf(el))) || clip(el.getAttribute('title') ?? el.getAttribute('placeholder'))
    || (el.getAttribute('role') === 'slider' ? clip(el.parentElement?.closest('[aria-label]')?.getAttribute('aria-label')) : '');
}

function stateOf(el) {
  const a = (n) => el.getAttribute(n);
  const s = [];
  if (el.disabled || a('aria-disabled') === 'true') s.push('disabled');
  if (el.checked || a('aria-checked') === 'true' || a('data-state') === 'checked') s.push('checked');
  if (a('aria-pressed') === 'true' || a('data-state') === 'on') s.push('pressed');
  if (a('aria-selected') === 'true') s.push('selected');
  if (a('aria-expanded') === 'true') s.push('expanded');
  if (a('aria-current') && a('aria-current') !== 'false') s.push('current');
  if (el === document.activeElement) s.push('focused');
  return s;
}

function valueOf(el) {
  const tag = el.localName;
  if ((tag === 'input' && TEXT_TYPES.includes(el.type)) || tag === 'textarea') return clip(el.value);
  if (tag === 'select') return clip(el.selectedOptions[0]?.textContent);
  const role = el.getAttribute('role');
  if (role === 'combobox') return clip(el.textContent);
  if (role === 'slider' || role === 'spinbutton') return el.getAttribute('aria-valuenow') ?? undefined;
  return undefined;
}

/** dialog (a modal), menu (a popover, menu or select list), status, page, or the nearest toolbar's label or data-agent-area. */
function areaOf(el) {
  if (el.closest(POPPER)) return 'menu';
  const a = el.closest('[role=dialog], [role=alertdialog], [data-agent-area], [role=toolbar], footer, #editor-area, #workspace-root, [data-notices]');
  if (!a) return 'page';
  if (a.matches('[role=dialog], [role=alertdialog]')) return 'dialog';
  if (a.matches('footer')) return 'status';
  if (a.matches('#editor-area, #workspace-root')) return 'page';
  if (a.matches('[data-notices]')) return 'notices';
  return a.dataset.agentArea ?? (labelOf(a).toLowerCase() || 'toolbar');
}

const boundsOf = (el) => {
  const r = el.getBoundingClientRect();
  return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
};

/** The INSIDE root of `el`, or null. A label counts as its control (a click on it reaches the control), and a portalled
 * menu or list as the control that opened it (its aria-controls names the content), so neither escapes a denied root. */
function insideOf(el, depth = 0) {
  const own = INSIDE.find(([s]) => el.closest(s))?.[1];
  if (own || depth > 4) return own ?? null;
  const id = el.closest(POPPER)?.firstElementChild?.id;
  const via = el.control ?? (id && document.querySelector(`[aria-controls="${CSS.escape(id)}"]`));
  return via ? insideOf(via, depth + 1) : null;
}

function recordOf(el) {
  const row = el.parentElement?.closest('.group'); // a list row (Tailwind group): its hover actions say which row they act on
  const t = el.control ?? el; // a label: judged as its control (a password or file input stays denied)
  return {
    el, tag: t.localName, type: t.localName === 'input' ? t.type : undefined, autocomplete: t.getAttribute('autocomplete'),
    inside: insideOf(el), role: roleOf(el), name: nameOf(el), in: row ? nameOf(row) || undefined : undefined,
    state: stateOf(el), value: valueOf(el), risk: el.dataset.agentRisk ?? t.dataset.agentRisk, area: areaOf(el), bounds: boundsOf(el),
  };
}

/** Whether `el` has a box and is not hidden; a control hidden until its row is hovered (Tailwind group-hover) counts as shown. */
function shown(el, cs = getComputedStyle(el)) {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height || el.closest(`[inert], [aria-hidden="true"]`)) return false;
  if (cs.visibility !== 'hidden') return true;
  const row = el.closest('.group');
  return !!row && getComputedStyle(row).visibility !== 'hidden';
}

/** Every listable control in document order (the walk skips marked roots, inert and aria-hidden subtrees and display: none). */
function readRecords() {
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
    acceptNode(el) {
      if (el.matches(SKIP)) return NodeFilter.FILTER_REJECT;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') return NodeFilter.FILTER_REJECT;
      const control = el.matches(CONTROL) || (cs.cursor === 'pointer' && getComputedStyle(el.parentElement).cursor !== 'pointer');
      return control && shown(el, cs) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  for (let el = walker.nextNode(); el; el = walker.nextNode()) out.push(recordOf(el));
  return out;
}

/** ui.snapshot {scope?, page?, query?} → snapshotPage's {page, pages, total, groups}. */
export function snapshot({ scope, page, query }) {
  const records = readRecords();
  refs.sweep((el) => el.isConnected);
  for (const r of records) r.ref = refs.of(r.el);
  return snapshotPage(records, { scope, query, page });
}

// ---------------------------------------------------------------------------------------------
// ui.invoke

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// One animation frame (at most 50 ms: a hidden window runs none).
const frame = () => new Promise((r) => {
  const t = setTimeout(r, 50);
  requestAnimationFrame(() => {
    clearTimeout(t);
    r();
  });
});
const settle = async () => {
  await frame();
  await frame();
  await sleep(150);
};

/** A short description of the focused element: 'document', 'assistant', `role "name"` or null. */
function focusNow() {
  const f = document.activeElement;
  if (!f || f === document.body) return null;
  if (f.closest('.ProseMirror')) return 'document';
  if (f.closest('#assistant-panel')) return 'assistant';
  return `${roleOf(f)} "${nameOf(f)}"`;
}

function observe(el) {
  const dialog = [...document.querySelectorAll('[role=dialog], [role=alertdialog]')].find((d) => !d.closest(POPPER) && shown(d));
  const menu = document.querySelector(`${POPPER} [role=menu], ${POPPER} [role=listbox], ${POPPER} [role=dialog]`);
  return {
    focus: focusNow(),
    dialog: dialog ? labelOf(dialog) || 'dialog' : null,
    menu: menu ? `${menu.getAttribute('role')}${labelOf(menu) ? ` "${labelOf(menu)}"` : ''}` : null,
    target: el.isConnected && shown(el) ? { name: nameOf(el), value: valueOf(el), state: stateOf(el).join(' ') } : null,
    notices: [...document.querySelectorAll('[data-notices] > *, [data-sonner-toast]')].map((n) => clip(n.textContent, 80)).filter(Boolean),
  };
}

/** A mouse click on `el`'s centre: pointermove, pointerdown, mousedown (then the focus, unless prevented), a frame, pointerup,
 * mouseup, click; as Radix triggers and menu items need. */
async function click(el) {
  const r = el.getBoundingClientRect();
  const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
  const ptr = { ...at, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  el.dispatchEvent(new PointerEvent('pointermove', { ...ptr, buttons: 0 }));
  const down = el.dispatchEvent(new PointerEvent('pointerdown', { ...ptr, buttons: 1 }));
  const mouse = down && el.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1, detail: 1 }));
  if (mouse && el.matches('button, a[href], input, select, textarea, summary, [tabindex]')) el.focus({ preventScroll: true });
  await frame();
  el.dispatchEvent(new PointerEvent('pointerup', { ...ptr, buttons: 0 }));
  if (down) el.dispatchEvent(new MouseEvent('mouseup', { ...at, buttons: 0, detail: 1 }));
  el.dispatchEvent(new MouseEvent('click', { ...at, buttons: 0, detail: 1 }));
}

/** Sets a field's value through the native setter (React's value tracker then sees the change), then input and change. */
function setValue(el, value) {
  const proto = el.localName === 'textarea' ? HTMLTextAreaElement : el.localName === 'select' ? HTMLSelectElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function key(el, name) {
  const init = { key: name === 'Space' ? ' ' : name, code: name, bubbles: true, cancelable: true, composed: true };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
}

const same = (a, b) => clip(a, 200).toLowerCase() === clip(b, 200).toLowerCase();

/** select: a native select's option, or a Radix select's: its trigger clicked, the option of that name clicked in its list. */
async function choose(el, value, name, signal) {
  if (el.localName === 'select') {
    const o = [...el.options].find((x) => same(x.textContent, value) || x.value === value);
    if (!o) fail('not_found', `"${name}" has no option "${value}"`, { options: [...el.options].map((x) => clip(x.textContent)).slice(0, 40) });
    setValue(el, o.value);
    return;
  }
  await click(el);
  await settle();
  if (signal.aborted) fail('cancelled', 'The call was cancelled');
  const list = document.getElementById(el.getAttribute('aria-controls') ?? '') ?? document.querySelector(`${POPPER} [role=listbox]`);
  const options = [...(list?.querySelectorAll('[role=option]') ?? [])];
  const o = options.find((x) => same(x.textContent, value));
  if (!o) {
    // Escape until the list is gone: the trigger's tooltip (opened by its focus) is the top layer and takes the first one.
    for (let i = 0; i < 3 && list?.isConnected; i++) {
      key(document.activeElement ?? document.body, 'Escape');
      await settle();
    }
    fail('not_found', `"${name}" has no option "${value}"`, { options: options.map((x) => clip(x.textContent)).slice(0, 40) });
  }
  await click(o);
}

const recent = []; // times of the ui.invoke calls in the last RATE.ms

const on = (r) => (r.in ? ` on "${r.in}"` : '');
const PHRASE = {
  click: (r) => `press "${r.name}"${on(r)} in the ${r.area}`,
  type: (r) => `type into "${r.name}"${on(r)} in the ${r.area}`,
  select: (r, a) => `choose "${a.value}" in "${r.name}"${on(r)} (${r.area})`,
  key: (r, a) => `send ${a.key} to "${r.name}"${on(r)} in the ${r.area}`,
};

/** ui.invoke {ref, action, text?, value?, key?} (ctx: the executor's) → {ref, action, name, in?, role, area, changes}. */
export async function invokeControl(ctx, a) {
  const need = { type: 'text', select: 'value', key: 'key' }[a.action];
  if (need && a[need] === undefined) fail('invalid_args', `args.${need} is needed for ${a.action}`, { path: `/${need}`, message: `is needed for ${a.action}`, expected: {} });
  const el = refs.get(a.ref);
  if (!el?.isConnected) fail('stale', `${a.ref} is no longer on screen; take a new ui_snapshot`);
  const r = recordOf(el);
  const why = denyReason(r);
  if (why) fail('denied', `"${r.name}" is ${why}`, { reason: 'policy' });
  if (!shown(el)) fail('refused', `"${r.name}" is not shown now (a dialog may cover it); take a new ui_snapshot`, { code: 'hidden' });
  if (!document.hasFocus()) {
    fail('refused', 'EasyWriter does not have the focus: a system dialog, the forum window or another program has it', { code: 'not_focused' });
  }
  if (r.state.includes('disabled')) fail('refused', `"${r.name}" is disabled`, { code: 'disabled' });
  const facts = { tag: el.localName, type: el.type, editable: el.isContentEditable };
  if (a.action === 'type' && !textField(facts)) fail('refused', `"${r.name}" is not a text field`, { code: 'not_a_field' });
  const noKey = a.action === 'key' && keyRefusal(a.key, facts);
  if (noKey) fail('refused', `${noKey}; "${r.name}" is not one`, { code: 'not_a_field' });
  if (a.action === 'select' && el.localName !== 'select' && r.role !== 'combobox') fail('refused', `"${r.name}" is not a select`, { code: 'not_a_select' });
  // Enter or Space in a list with a highlighted item (aria-activedescendant; cmdk runs its selected item on any Enter) acts on
  // that item, whose deny and risk this control does not carry.
  if (a.action === 'key' && (a.key === 'Enter' || a.key === 'Space') && el.closest('[cmdk-root], [aria-activedescendant]')) {
    fail('refused', `Enter or Space in "${r.name}" acts on the highlighted item; click that item instead`, { code: 'use_click' });
  }
  const now = Date.now();
  while (recent.length && now - recent[0] > RATE.ms) recent.shift();
  if (recent.length >= RATE.max) fail('refused', `At most ${RATE.max} controls a minute; use a command, or wait`, { code: 'rate_limit' });
  recent.push(now);
  const risk = riskOf(r);
  const rule = ctx.policy[risk]; // for the assistant in Ask first, 'ask' for every control
  if (rule === 'deny') fail('denied', `"${r.name}" is not allowed for ${ctx.source}`, { reason: 'policy' });
  if (rule === 'ask') {
    if (ctx.state.dialog || ctx.state.confirm) fail('denied', 'The approval card cannot show over a dialog; ask the user to press it', { reason: 'policy' });
    if (!(await ctx.ask(PHRASE[a.action](r, a), '', { risk }))) fail('denied', 'The user denied the request', { reason: 'user' });
    // The card waited: the element must still be the control (and row) the user approved, shown and not denied.
    const now = el.isConnected && recordOf(el);
    if (!now || now.name !== r.name || now.in !== r.in || denyReason(now) || !shown(el)) fail('stale', `"${r.name}" changed while the card waited; take a new ui_snapshot`);
  }
  if (ctx.signal.aborted) fail('cancelled', 'The call was cancelled');
  const before = observe(el);
  if (a.action === 'click') await click(el);
  else if (a.action === 'type') {
    el.focus({ preventScroll: true });
    setValue(el, a.text);
  } else if (a.action === 'key') key(el, a.key);
  else await choose(el, a.value, r.name, ctx.signal);
  await settle();
  return { ref: a.ref, action: a.action, name: r.name, ...(r.in && { in: r.in }), role: r.role, area: r.area, changes: changes(before, observe(el)) };
}
