// The clipboard package's editor plugin (docs/plans/word plan.md §3 clipboard): paste options on every paste into a Document
// editor (the default for the source, or the option picked), smart cut and paste, the Paste Options button's range, table paste
// choices, copy records for the Clipboard pane, and the Format Painter's cursor and apply on mouseup. Lists' paste hooks
// (lists.js, priority 102) run before these (default priority 100), so the HTML arrives normalised once.
import { Extension } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Fragment, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { getState } from '../../../app/store.js';
import { ensureStyles } from '../../model/styles.mjs';
import { closeButton, setClipKey, showButton } from './button.js';
import { applyPick, docKey, mem, painterNow, pasteSettings, recordCopy, setPainter, sourceOf } from './core.js';
import { applyMode, defaultMode, pasteCase, sourceKind, stylesConflict } from './modes.mjs';
import { deleteFix, pasteSpacing, wholeWords } from './smart.mjs';

export const clipKey = new PluginKey('wordClipboard');
setClipKey(clipKey);

/** `json` (node JSON) with every attribute its node or mark type lacks removed, so Slice.fromJSON accepts it. */
function fitAttrs(schema, json) {
  const fit = (attrs, type) => (attrs && type ? Object.fromEntries(Object.entries(attrs).filter(([k]) => k in type.attrs)) : attrs);
  const node = (n) => ({
    ...n,
    attrs: fit(n.attrs, schema.nodes[n.type]),
    ...(n.marks && { marks: n.marks.filter((m) => schema.marks[m.type]).map((m) => ({ ...m, attrs: fit(m.attrs, schema.marks[m.type]) })) }),
    ...(n.content && { content: n.content.filter((c) => schema.nodes[c.type]).map(node) }),
  });
  return json.map(node);
}

/** Whether `slice` holds list paragraphs (the Paste Options button then offers lists' Continue List and New List). */
function hasLists(slice) {
  let found = false;
  slice.content.descendants((n) => {
    if (n.attrs?.numbering) found = true;
    return !found;
  });
  return found;
}

/** The single table `slice` holds as whole rows (a copied table or rows), or null. */
function pastedTable(slice) {
  const first = slice.content.firstChild;
  if (slice.content.childCount === 1 && first?.type.name === 'table') return first;
  if (first?.type.name === 'tableRow') return first.type.schema.nodes.table.create(null, slice.content);
  return null;
}

/** Smart paste spacing (smart.mjs) on a slice that pastes inline into one paragraph over `$from`..`$to`. */
function smartSlice(slice, $from, $to) {
  if (slice.openStart < 1 || slice.content.childCount !== 1 || !slice.content.firstChild.isTextblock || !$from.parent.isTextblock) return slice;
  const para = slice.content.firstChild;
  const text = para.textContent;
  const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset, undefined, '￼');
  const after = $to.parent.textBetween($to.parentOffset, Math.min($to.parent.content.size, $to.parentOffset + 1), undefined, '￼');
  const fix = pasteSpacing(before, text, after);
  if (!fix.lead && !fix.trail && !fix.dropLead && !fix.dropTrail) return slice;
  const schema = para.type.schema;
  const nodes = [];
  para.content.forEach((n) => nodes.push(n));
  const edit = (i, fn) => {
    if (nodes[i]?.isText) {
      const t = fn(nodes[i].text);
      nodes[i] = t ? schema.text(t, nodes[i].marks) : null;
    }
  };
  if (fix.dropLead) edit(0, (t) => t.slice(fix.dropLead));
  if (fix.dropTrail) edit(nodes.length - 1, (t) => t.slice(0, t.length - fix.dropTrail));
  if (fix.lead) edit(0, (t) => ` ${t}`);
  if (fix.trail) edit(nodes.length - 1, (t) => `${t} `);
  return new Slice(Fragment.from(para.copy(Fragment.from(nodes.filter(Boolean)))), slice.openStart, slice.openEnd);
}

/** Pasted `slice` under the paste in progress (mem.current): its option applied and its spacing fixed. Records what the Paste
 * Options button needs on `pending`. */
function transform(slice, view, pending) {
  const cur = mem.current;
  const { state } = view;
  const settings = pasteSettings();
  if (cur && cur.kind) {
    const content = slice.content.toJSON() ?? [];
    const src = cur.src !== undefined ? cur.src : sourceOf(cur.data);
    const dst = { docKey: docKey(view), styles: state.doc.attrs.styles, theme: state.doc.attrs.theme };
    const which = pasteCase(cur.kind, content, src, dst);
    const mode = cur.mode ?? defaultMode(which, settings);
    const { $from } = state.selection;
    const res = applyMode(mode, content, {
      srcStyles: src?.styles, dstStyles: dst.styles, srcTheme: src?.theme, dstTheme: dst.theme, sameDoc: which === 'within',
      destAttrs: $from.parent.isTextblock ? $from.parent.attrs : {}, destMarks: (state.storedMarks ?? $from.marks()).map((m) => m.toJSON()),
      keepBullets: settings.keepBullets, numbering: src?.numbering ?? state.doc.attrs.numbering,
    });
    if (res.content !== content) {
      try {
        // Inline content came back wrapped in one paragraph (modes.mjs textOnly): opened both sides, it still pastes inline.
        const inline = !!slice.content.firstChild?.isInline;
        const open = res.flat ? (inline ? 1 : Math.min(slice.openStart, 1)) : slice.openStart;
        const openEnd = res.flat ? (inline ? 1 : Math.min(slice.openEnd, 1)) : slice.openEnd;
        slice = new Slice(Fragment.fromJSON(state.schema, fitAttrs(state.schema, res.content)), res.content.length ? open : 0, res.content.length ? openEnd : 0);
      } catch (e) {
        console.error('Paste option failed; pasted as is.', e);
      }
    }
    Object.assign(pending, {
      data: cur.data, kind: cur.kind, src, mode, which, addStyles: res.addStyles, lists: hasLists(slice),
      stylesDiffer: !!src && stylesConflict(content, src.styles, dst.styles),
      themeDiffer: !!src && JSON.stringify(src.theme ?? null) !== JSON.stringify(dst.theme ?? null),
    });
  }
  return settings.smart ? smartSlice(slice, state.selection.$from, state.selection.$to) : slice;
}

/** Inserts `table`'s rows above the caret's row in the table holding `$from` (Word's default for whole rows pasted at a caret in a
 * cell, unverified), each row padded or cut to the table's column count. → the transaction or null. */
function rowsAbove(state, table) {
  const { $from } = state.selection;
  let d = $from.depth;
  while (d > 0 && $from.node(d).type.name !== 'tableRow') d--;
  if (!d) return null;
  const target = $from.node(d - 1);
  const cols = TableMap.get(target).width;
  const { schema } = state;
  const rows = [];
  table.forEach((row) => {
    const cells = [];
    let width = 0;
    row.forEach((cell) => {
      if (width >= cols) return;
      cells.push(cell);
      width += cell.attrs.colspan ?? 1;
    });
    while (width++ < cols) cells.push(schema.nodes.tableCell.createAndFill());
    rows.push(row.type.create(row.attrs, cells));
  });
  const at = $from.before(d);
  return { tr: state.tr.insert(at, rows), from: at, to: at + rows.reduce((s, r) => s + r.nodeSize, 0) };
}

/** Writes `table`'s cells over the cells from the caret's cell on (Overwrite Cells at a caret), cells past the table's edge dropped. */
function overwriteCells(state, table) {
  const { $from } = state.selection;
  let d = $from.depth;
  while (d > 0 && !/^table(Cell|Header)$/.test($from.node(d).type.name)) d--;
  if (d < 3) return null;
  const tableNode = $from.node(d - 2);
  const tableStart = $from.start(d - 2);
  const map = TableMap.get(tableNode);
  const rect = map.findCell($from.before(d) - tableStart);
  const tr = state.tr;
  const src = TableMap.get(table);
  for (let r = 0; r < src.height && rect.top + r < map.height; r++) {
    for (let c = 0; c < src.width && rect.left + c < map.width; c++) {
      const cell = table.nodeAt(src.map[r * src.width + c]);
      const pos = tableStart + map.map[(rect.top + r) * map.width + rect.left + c];
      const at = tr.mapping.map(pos + 1);
      const old = state.doc.nodeAt(pos);
      tr.replaceWith(at, tr.mapping.map(pos + old.nodeSize - 1), cell.content);
    }
  }
  return { tr, from: tableStart - 1, to: tableStart - 1 + tableNode.nodeSize };
}

/** The clipboard package's Document-kit extension. */
export const ClipboardExtension = Extension.create({
  name: 'wordClipboard',
  addProseMirrorPlugins() {
    const pending = {}; // what transform learnt about the paste being dispatched
    let dropAt = null; // a drop's position, for smart spacing at the drop point
    let ctrl = false; // a Ctrl press with no other key yet (Word's Ctrl tap opens the Paste Options menu)
    return [new Plugin({
      key: clipKey,
      state: {
        init: () => null,
        // The last paste of this editor: {from, to, data, kind, src, mode, ...} while its Paste Options button shows.
        apply(tr, value, old) {
          const meta = tr.getMeta(clipKey);
          if (meta?.paste) return meta.paste;
          if (tr.getMeta('paste') && pending.kind) {
            const from = tr.mapping.map(old.selection.from, -1);
            const out = { ...pending, from, to: Math.max(from, tr.selection.to) };
            for (const k of Object.keys(pending)) delete pending[k];
            return out;
          }
          if (!value) return null;
          // Typing or any other edit ends the button (appended transactions such as lists' numbering belong to the paste).
          if (tr.docChanged && !tr.getMeta('appendedTransaction') && !meta?.keep) return null;
          return tr.docChanged ? { ...value, from: tr.mapping.map(value.from, -1), to: tr.mapping.map(value.to, 1) } : value;
        },
      },
      appendTransaction(trs, oldState, state) {
        let tr = null;
        const pasted = trs.some((t) => t.getMeta('paste'));
        // Keep Source Formatting brings the source styles the destination lacks, in the paste's own undo step.
        const add = pasted && clipKey.getState(state)?.addStyles;
        if (add) {
          const styles = ensureStyles(state.doc, add);
          if (styles) tr = state.tr.setDocAttribute('styles', styles);
        }
        // Smart cut: a cut, a drag that moves text, or a deleted selection of whole words leaves no double space.
        if (!pasteSettings().smart) return tr;
        for (const t of trs) {
          const ui = t.getMeta('uiEvent');
          const sel = t.before === oldState.doc ? oldState.selection : null;
          if (!sel || sel.empty || !sel.$from.sameParent(sel.$to) || !sel.$from.parent.isTextblock) continue;
          const isDelete = t.steps.length === 1 && t.steps[0].from === sel.from && t.steps[0].to === sel.to && t.steps[0].slice?.size === 0;
          if (!(ui === 'cut' || ui === 'drop' || isDelete)) continue;
          const p = sel.$from.parent;
          const text = p.textBetween(0, p.content.size, undefined, '￼');
          if (!wholeWords(text, sel.$from.parentOffset, sel.$to.parentOffset)) continue;
          const doc = (tr ?? state).doc;
          const at = trs.slice(trs.indexOf(t)).reduce((pos, x) => x.mapping.map(pos, -1), sel.from);
          const $at = doc.resolve(at);
          if (!$at.parent.isTextblock) continue;
          const before = at > $at.start() ? doc.textBetween(at - 1, at, undefined, '￼') : '';
          const after = at < $at.end() ? doc.textBetween(at, at + 1, undefined, '￼') : '';
          const fix = deleteFix(before, after);
          if (!fix) continue;
          tr ??= state.tr;
          tr.delete(fix === 'before' ? at - 1 : at, fix === 'before' ? at : at + 1);
        }
        return tr;
      },
      props: {
        attributes: () => {
          const p = painterNow();
          return p ? { 'data-painter': p } : {};
        },
        handleDOMEvents: {
          paste(view, event) {
            if (!view.dom.isConnected || mem.current) return false;
            const cd = event.clipboardData;
            if (!cd) return false;
            const data = { html: cd.getData('text/html'), text: cd.getData('text/plain'), image: null };
            const kind = sourceKind(data);
            if (!kind) return false; // pictures from files: the app's image paste handles them
            mem.current = { data, kind, mode: null };
            // A paste another handler takes (a cell selection's) never reaches transformPasted's reader: forget it after the event.
            setTimeout(() => { if (mem.current?.data === data) mem.current = null; });
            return false;
          },
          copy(view) {
            if (view.dom.isConnected && !view.state.selection.empty) recordCopy(view, view.state.selection.content());
            return false;
          },
          cut(view) {
            if (view.dom.isConnected && !view.state.selection.empty) recordCopy(view, view.state.selection.content());
            return false;
          },
          drop(view, event) {
            dropAt = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null;
            setTimeout(() => { dropAt = null; });
            return false;
          },
          mouseup(view) {
            if (!painterNow() || !view.dom.isConnected) return false;
            // After the click or drag has set the selection.
            setTimeout(() => {
              if (!painterNow()) return;
              applyPick(view);
              if (painterNow() === 'once') setPainter(null, view.dom.editor);
            });
            return false;
          },
          keyup(view, event) {
            if (event.key === 'Control' && ctrl) {
              ctrl = false;
              if (clipKey.getState(view.state) && pasteSettings().button) showButton(view, { toggle: true });
            }
            return false;
          },
        },
        handleKeyDown(view, event) {
          ctrl = event.key === 'Control' && !event.shiftKey && !event.altKey && !event.metaKey;
          if (event.key === 'Escape' && painterNow()) {
            setPainter(null, view.dom.editor);
            return true;
          }
          return false;
        },
        transformPasted(slice, view) {
          if (!view.dom.isConnected) return slice;
          // A drop takes no paste option, only the spacing at the drop point.
          if (dropAt != null && !mem.current) {
            const $at = view.state.doc.resolve(Math.min(dropAt, view.state.doc.content.size));
            return pasteSettings().smart ? smartSlice(slice, $at, $at) : slice;
          }
          return transform(slice, view, pending);
        },
        handlePaste(view, event, slice) {
          const cur = mem.current;
          if (!cur || cur.tableChoice === 'nestTable' || view.state.selection instanceof CellSelection) return false;
          const table = pastedTable(slice);
          if (!table) return false;
          const { $from } = view.state.selection;
          let inCell = false;
          for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'tableRow') inCell = true;
          if (!inCell) return false;
          const choice = cur.tableChoice ?? 'insertAsNewRows';
          const done = choice === 'overwriteCells' ? overwriteCells(view.state, table) : rowsAbove(view.state, table);
          if (!done) return false;
          const record = { ...pending, data: cur.data, kind: cur.kind, mode: 'keepSourceFormatting', table: choice, from: done.from, to: done.to };
          for (const k of Object.keys(pending)) delete pending[k];
          // Its own undo step, so a table choice from the button can undo it whole.
          view.dispatch(closeHistory(done.tr).scrollIntoView().setMeta('uiEvent', 'paste').setMeta(clipKey, { paste: record }));
          return true;
        },
      },
      view(view) {
        const update = () => {
          const st = clipKey.getState(view.state);
          if (st && pasteSettings().button && view.dom.isConnected && getState().draft?.format === 'document') showButton(view);
          else closeButton(view);
        };
        return { update, destroy: () => closeButton(view) };
      },
    })];
  },
});
