// Pure rules of the ribbon's chrome (docs/plans/word briefs/ribbon-chrome.md): the F6 focus cycle and the Quick Access
// Toolbar's customise menu. No DOM and no app import, so node tests load them.

/** The F6 cycle over the regions present now: the document, the task panes (left, then right, then bottom), the status bar,
 * the ribbon. `panes`: [{id, side}] of the open panes; `statusbar`, `ribbon`: whether they are shown. → region ids in order
 * ('document', 'pane:<id>', 'statusbar', 'ribbon'). */
export function regionOrder({ panes = [], statusbar = false, ribbon = false } = {}) {
  const side = { left: 0, right: 1, bottom: 2 };
  const shown = [...panes].sort((a, b) => (side[a.side] ?? 3) - (side[b.side] ?? 3)).map((p) => `pane:${p.id}`);
  return ['document', ...shown, ...(statusbar ? ['statusbar'] : []), ...(ribbon ? ['ribbon'] : [])];
}

/** The region F6 (`dir` 1) or Shift+F6 (`dir` -1) moves to from `current` within `order`; a focus in none of them counts as
 * the document's. */
export function nextRegion(order, current, dir = 1) {
  if (!order.length) return null;
  const i = Math.max(0, order.indexOf(current));
  return order[(i + dir + order.length) % order.length];
}

/** The customise menu of the Quick Access Toolbar (probe/menus/frame.customize-quick-access-toolbar.json, in Word's order):
 * check items by the command id the bar shows. AutoSave is left out (cloud); Email and Editor stay as cloud placeholders. */
export const QAT_MENU = [
  { id: 'file.new', label: 'New' },
  { id: 'file.open', label: 'Open' },
  { id: 'frame.qat.save', label: 'Save' },
  { id: 'frame.qat.email', label: 'Email', needs: 'cloud' },
  { id: 'print.quickPrint', label: 'Quick Print' },
  { id: 'file.print', label: 'Print Preview and Print' },
  { id: 'frame.qat.editor', label: 'Editor', needs: 'cloud' },
  { id: 'review.speech.readAloud', label: 'Read Aloud' },
  { id: 'frame.qat.undo', label: 'Undo' },
  { id: 'frame.qat.redoRepeat', label: 'Redo' },
  { id: 'insert.tables.table.drawTable', label: 'Draw Table' },
  { id: 'frame.qat.touchMouseMode', label: 'Touch/Mouse Mode' },
];

/** The bar's ids after the menu's check item `id` is toggled: a checked one leaves the bar where it stood, an unchecked one
 * joins it at the end (Word adds to the right). */
export const toggleQat = (qat, id) => (qat.includes(id) ? qat.filter((x) => x !== id) : [...qat, id]);

/** `qat` with `id` moved by `by` places (Options > Quick Access Toolbar's Move Up and Move Down); the ends hold. */
export function moveQat(qat, id, by) {
  const i = qat.indexOf(id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= qat.length) return qat;
  const out = [...qat];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
