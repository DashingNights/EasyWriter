// The content control rules that need no view (plan.md §1.8 sdt object, §3 content-controls): the locks, typing into a control,
// placeholders, temporary controls and the two-way property bindings. The plugin in extension.js calls them; node tests load this file.
import { Mapping } from '@tiptap/pm/transform';
import { deepPatch } from '../../../office.mjs';
import { boundDate, controlList, controlsById, dateValue, hasPlaceholder, lockRefusal, newSdt, placeholderOf, propPatch, propValue } from './model.mjs';
import { contentOf, controlAt, flags, KEY, sdtOf, unwrapControl } from './ops.js';

/** A control's content is empty: no text, no other leaf (a picture) and no control nested in it, even an emptied one, so only
 * the inner control brings its placeholder back. */
const emptyContent = (node) => !node.textContent && !node.content.content.some((c) => c.isLeaf || c.childCount || c.type.name === 'sdtInline');

/** The value a bound control gives its property: '' while it shows its placeholder, 'true' or 'false' for a check box, the ISO
 * day for a date still showing the day picked. A picture has no text value, so it gives none (null) and is never rewritten. */
const boundValue = (node, s = sdtOf(node)) => {
  if (s.type === 'picture') return null;
  if (s.type === 'checkbox') return String(!!s.checked);
  if (s.showingPlaceholder) return '';
  return s.type === 'date' ? dateValue(s.date, node.textContent) : node.textContent;
};

/** Why `tr` on `state` breaks a lock, or null. The plugin's own transactions pass, and so does a load: setContent (the only
 * writer of the 'preventUpdate' meta). A select-all edit replaces the whole document too, so the step range cannot tell them. */
export function lockCheck(tr, state) {
  if (!tr.docChanged || tr.getMeta(KEY) || tr.getMeta('preventUpdate') !== undefined) return null;
  return lockRefusal(state.doc, tr.doc);
}

/** Drops what is left of the placeholder of the control at `pos` (in state.doc), which was `before` at `oldPos` in `oldDoc`:
 * an IME or a paste put text inside the grey text without replacing it (typed keys replace it whole in typeInto). Every old
 * placeholder character that `map` carries through untouched is deleted; when nothing new is left, the placeholder comes back. */
function dropPlaceholder(tr, pos, oldPos, before, oldDoc, map) {
  const kept = [];
  for (let i = oldPos + 1; i < oldPos + before.nodeSize - 1; i++) {
    const from = map.map(i, 1);
    if (map.map(i + 1, -1) - from === 1 && oldDoc.textBetween(i, i + 1)) kept.push(tr.mapping.map(from));
  }
  for (const at of kept.reverse()) tr.delete(at, at + 1);
  const at = tr.mapping.map(pos);
  const now = tr.doc.nodeAt(at);
  const empty = emptyContent(now);
  if (empty) tr.replaceWith(at + 1, at + now.nodeSize - 1, contentOf(tr.doc.type.schema, now, placeholderOf(sdtOf(now))));
  tr.setNodeMarkup(at, null, { ...now.attrs, sdt: { ...now.attrs.sdt, showingPlaceholder: empty } });
}

/** The fixes one change needs: placeholders shown or dropped, temporary controls removed, copied controls given their own ids,
 * bound properties written and every control bound to a changed property rewritten. → a transaction or null. Values are
 * compared, so a write never echoes. */
export function follow(trs, oldState, state) {
  const docChanged = trs.some((t) => t.docChanged);
  const propsChanged = state.doc.attrs.props !== oldState.doc.attrs.props;
  if ((!docChanged && !propsChanged) || trs.some((t) => t.getMeta(KEY))) return null;
  const list = controlList(state.doc);
  if (!list.length) return null;
  const old = controlsById(oldState.doc);
  const map = new Mapping();
  for (const t of trs) map.appendMapping(t.mapping);
  const ops = []; // [{pos, run(tr)}], applied from the end so earlier positions hold
  const writes = {}; // props path → value
  const writers = new Set();
  const seen = new Set();
  for (const { pos, node } of list) {
    const s = sdtOf(node);
    if (s.id && seen.has(s.id)) {
      // A pasted copy: Word gives it its own id, so locks and bindings keep telling it from the original.
      ops.push({ pos, run: (tr) => tr.setNodeMarkup(pos, null, { ...node.attrs, sdt: { ...node.attrs.sdt, id: newSdt('x').id } }) });
      continue;
    }
    seen.add(s.id);
    const was = s.id ? old.get(s.id) : null;
    const before = was?.node;
    const changed = before && !before.content.eq(node.content);
    if (s.showingPlaceholder && changed) {
      const ph = placeholderOf(s);
      if (flags.design) {
        ops.push({ pos, run: (tr) => tr.setNodeMarkup(pos, null, { ...node.attrs, sdt: { ...node.attrs.sdt, placeholder: node.textContent } }) });
      } else if (s.type === 'picture' ? !emptyContent(node) : node.textContent !== ph) {
        if (s.type !== 'picture' && sdtOf(before).showingPlaceholder) {
          ops.push({ pos, run: (tr) => dropPlaceholder(tr, pos, was.pos, before, oldState.doc, map) });
        } else {
          ops.push({ pos, run: (tr) => tr.setNodeMarkup(pos, null, { ...node.attrs, sdt: { ...node.attrs.sdt, showingPlaceholder: false } }) });
        }
        s.showingPlaceholder = false;
      }
    } else if (!s.showingPlaceholder && hasPlaceholder(s) && emptyContent(node) && (changed || !before)) {
      // Emptying a control brings its placeholder back.
      ops.push({ pos, run: (tr) => {
        tr.replaceWith(pos + 1, pos + node.nodeSize - 1, contentOf(state.schema, node, placeholderOf(s)));
        tr.setNodeMarkup(pos, null, { ...node.attrs, sdt: { ...node.attrs.sdt, showingPlaceholder: true } });
      } });
      s.showingPlaceholder = true;
    } else if (s.temporary && changed && !s.showingPlaceholder) {
      ops.push({ pos, run: (tr) => unwrapControl(tr, pos) });
    }
    const path = s.binding?.prop;
    const value = path && before ? boundValue(node, s) : null;
    if (value == null) continue;
    if (changed || (s.type === 'checkbox' && before.attrs.sdt?.checked !== node.attrs.sdt?.checked)) {
      writes[path] = value;
      writers.add(pos);
    }
  }
  let props = state.doc.attrs.props ?? {};
  for (const [path, value] of Object.entries(writes)) if (propValue(props, path) !== value) props = deepPatch(props, propPatch(path, value));
  const newProps = props !== (state.doc.attrs.props ?? {});
  if (newProps || propsChanged) {
    for (const { pos, node } of list) {
      const s = sdtOf(node);
      const path = s.binding?.prop;
      const had = path ? boundValue(node, s) : null;
      const value = path ? propValue(props, path) : '';
      if (had == null || writers.has(pos) || had === value) continue;
      if (s.type === 'checkbox') {
        // A check box follows only a yes or no value; other text leaves it as it is.
        if (!/^(true|false|1|0)$/.test(value)) continue;
        const on = value === 'true' || value === '1';
        if (on === !!s.checked) continue;
        ops.push({ pos, run: (tr) => {
          tr.replaceWith(pos + 1, pos + node.nodeSize - 1, contentOf(state.schema, node, on ? s.checkedChar : s.uncheckedChar));
          tr.setNodeMarkup(pos, null, { ...node.attrs, sdt: { ...node.attrs.sdt, checked: on } });
        } });
        continue;
      }
      const shown = s.type === 'date' ? boundDate(s.date, value) : { text: value };
      const date = s.type === 'date' ? { date: { ...node.attrs.sdt.date, full: shown.full } } : null;
      ops.push({ pos, run: (tr) => {
        tr.replaceWith(pos + 1, pos + node.nodeSize - 1, contentOf(state.schema, node, shown.text || placeholderOf(s)));
        tr.setNodeMarkup(pos, null, { ...node.attrs, sdt: { ...node.attrs.sdt, showingPlaceholder: !value, ...date } });
      } });
    }
  }
  if (!ops.length && !newProps) return null;
  const tr = state.tr.setMeta(KEY, true);
  for (const op of ops.sort((a, b) => b.pos - a.pos)) op.run(tr);
  if (newProps) tr.setDocAttribute('props', props);
  return tr;
}

/** The control around the caret whose type takes no typing, or one showing its placeholder. */
export function typingTarget(state) {
  const c = controlAt(state.selection.$from);
  return c && { ...c, s: sdtOf(c.node) };
}

/** Typing `text` at the selection of `state` → a transaction, true when the control swallows it (a check box, a drop-down list
 * and a picture change by click or pick only), or null when the text goes in as usual. The first character replaces a placeholder. */
export function typeInto(state, text) {
  const c = typingTarget(state);
  if (!c) return null;
  const { s, pos, node } = c;
  if (s.type === 'checkbox' || s.type === 'dropDown' || s.type === 'picture') return true;
  if (!s.showingPlaceholder || flags.design) return null;
  const tr = state.tr.replaceWith(pos + 1, pos + node.nodeSize - 1, contentOf(state.schema, node, text));
  tr.setNodeMarkup(pos, null, { ...node.attrs, sdt: { ...node.attrs.sdt, showingPlaceholder: false } });
  return tr;
}
