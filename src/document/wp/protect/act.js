// Restrict Editing's actions on the Document editor: start and stop enforcement, exceptions, Mark as Final, Always Open
// Read-Only and the session opened read-only. Every change protect makes on the user's behalf carries meta 'wordEngine', so the
// enforcement filter lets it through (Stop Protection runs while protection is on).
import { PluginKey } from '@tiptap/pm/state';
import { getState } from '../../../app/store.js';
import { sectionsOf } from '../../model/sections.mjs';
import { wordSettings } from '../../word/settings.mjs';
import { isFinal, regionsOf } from './filter.mjs';
import { hashPassword, verifyPassword } from './hash.mjs';

/** The protect plugin's key; its state is {session: opened read-only, highlight: shade the regions I can edit}. */
export const protectKey = new PluginKey('protect');

export const EDIT_TYPES = [['trackedChanges', 'Tracked changes'], ['comments', 'Comments'], ['forms', 'Filling in forms'], ['readOnly', 'No changes (Read only)']];

/** settings.word.user.name, whose permission marks open regions to this user. */
export const userName = () => wordSettings(getState().settings ?? {}).user?.name ?? '';

export const protectionOf = (ed) => ed?.state.doc.attrs.settings?.protection ?? null;
export const enforced = (ed) => !!protectionOf(ed)?.enforcement;
export const sessionOf = (ed) => (ed && protectKey.getState(ed.state)) || { session: false, highlight: true };
/** The regions of `ed`'s doc the current user may edit → [{from, to}]. */
export const myRegions = (ed) => (ed ? regionsOf(ed.state.doc, userName()) : []);

/** Runs a chain on `ed` marked as an engine change. */
const engine = (ed) => ed.chain().setMeta('wordEngine', true);

/** Sets plugin state `patch` ({session, highlight}) on `ed` with a meta-only transaction. */
export const setSession = (ed, patch) => ed.view.dispatch(ed.state.tr.setMeta(protectKey, patch));

/** Starts enforcement on `ed`: `opts` {edit (null for formatting only), formatting, fmt: {locked: style ids, autoFormatOverride,
 * lockTheme, lockQFSet} | null, sections: bool[] | null (forms: protected per section)}; `password` ('' for none) is hashed and
 * dropped. */
export async function startEnforcing(ed, { edit, formatting, fmt, sections }, password) {
  const hash = password ? await hashPassword(password) : { algorithmName: null, hashValue: null, saltValue: null, spinCount: null };
  const protection = {
    edit: edit ?? 'none', formatting: !!formatting, enforcement: true, ...hash,
    autoFormatOverride: !!fmt?.autoFormatOverride, lockTheme: !!fmt?.lockTheme, lockQFSet: !!fmt?.lockQFSet,
  };
  let c = engine(ed).setDocSettings({ protection });
  if (formatting && fmt?.locked) {
    const locked = new Set(fmt.locked);
    c = c.command(({ tr }) => {
      const styles = tr.doc.attrs.styles ?? {};
      const list = Object.fromEntries(Object.entries(styles.list ?? {}).map(([id, s]) => [id, { ...s, locked: locked.has(id) }]));
      tr.setDocAttribute('styles', { ...styles, list });
      return true;
    });
  }
  if (edit === 'forms') {
    const n = sectionsOf(ed.state.doc).length; // Word protects every section unless Select sections... says otherwise
    for (let i = 0; i < n; i++) c = c.setSectionProps({ formProt: sections?.[i] ?? true }, { section: i });
  }
  return c.run();
}

/** Stops enforcement on `ed`, asking the password when one is set (`ask` → the typed password or null). → whether it stopped. */
export async function stopProtection(ed, ask) {
  const p = protectionOf(ed);
  if (!p?.enforcement) return true;
  if (p.hashValue) {
    const typed = await ask();
    if (typed == null) return false;
    if (!(await verifyPassword(typed, p))) return false;
  }
  return engine(ed).setDocSettings({ protection: { enforcement: false, hashValue: null, saltValue: null } }).run();
}

/** Whether every inline node of `ed`'s selection carries a permission mark for `name`. */
export function permitted(ed, name) {
  const { from, to, empty } = ed.state.selection;
  if (empty) return false;
  let all = true;
  let any = false;
  ed.state.doc.nodesBetween(from, to, (node) => {
    if (!node.isInline) return true;
    any = true;
    if (!node.marks.some((m) => m.type.name === 'permission' && m.attrs.ed === name)) all = false;
    return false;
  });
  return any && all;
}

/** Adds (on) or removes a permission mark for `name` ('everyone' or a user) over `ed`'s selection. */
export function setPermission(ed, name, on) {
  const { from, to } = ed.state.selection;
  const type = ed.schema.marks.permission;
  const tr = ed.state.tr;
  if (on) tr.addMark(from, to, type.create({ id: Date.now().toString(36), ed: name }));
  else {
    ed.state.doc.nodesBetween(from, to, (node) => {
      for (const m of node.marks) if (m.type === type && m.attrs.ed === name) tr.removeMark(from, to, m);
    });
  }
  // Exceptions are setup, made while protection is off: they pass the filter even in Viewing mode, final or a read-only session.
  if (!protectionOf(ed)?.enforcement) tr.setMeta('wordEngine', true);
  ed.view.dispatch(tr);
}

/** The names other than everyone that permission marks in `ed`'s doc name. */
export function namesIn(ed) {
  const names = new Set();
  ed?.state.doc.descendants((node) => {
    for (const m of node.marks) if (m.type.name === 'permission' && m.attrs.ed && m.attrs.ed !== 'everyone') names.add(m.attrs.ed);
  });
  return [...names];
}

/** Selects the next region the user may edit after the selection, wrapping to the first → whether there is one. */
export function findNextRegion(ed) {
  const all = myRegions(ed);
  if (!all.length) return false;
  const r = all.find((x) => x.from >= ed.state.selection.to) ?? all[0];
  ed.chain().focus().setTextSelection(r).scrollIntoView().run();
  return true;
}

const FINAL = { name: '_MarkAsFinal', type: 'bool', value: true };

/** Marks `ed`'s doc as final (doc.attrs.props custom _MarkAsFinal, core contentStatus Final) or, `on` false, removes the mark
 * (Edit Anyway). */
export function setFinal(ed, on) {
  return engine(ed).command(({ tr }) => {
    const props = tr.doc.attrs.props ?? {};
    const custom = (props.custom ?? []).filter((p) => p?.name !== FINAL.name);
    const core = { ...props.core, contentStatus: on ? 'Final' : props.core?.contentStatus === 'Final' ? null : props.core?.contentStatus ?? null };
    tr.setDocAttribute('props', { ...props, core, custom: on ? [...custom, FINAL] : custom });
    return true;
  }).run();
}

export const finalOf = (ed) => !!ed && isFinal(ed.state.doc);
export const writeProtected = (ed) => !!ed?.state.doc.attrs.settings?.writeProtection?.recommended;

/** Always Open Read-Only on or off. */
export const setWriteProtection = (ed, on) => engine(ed).setDocSettings({ writeProtection: on ? { recommended: true } : null }).run();
