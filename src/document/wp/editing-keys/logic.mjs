// The pure parts of editing-keys' modes (docs/plans/word briefs/editing-keys.md): the Go Back ring, what Repeat does, the Undo
// list's labels and the ranges of a column (block) selection. Node tests load it.

export const RING = 4; // Word's Go Back remembers the last four edit positions

/** Ring `ring` (newest first) after an edit at `pos` → a new ring; an edit in the same textblock as the newest (`same`) moves it. */
export const pushEdit = (ring, pos, same = false) => [pos, ...(same ? ring.slice(1) : ring)].slice(0, RING);

/** Go Back's next stop from step `index` (-1 before the first press) with the caret at `head` → {index, pos} or null for an empty
 * ring. A stop equal to the caret is skipped, so the first press goes to the newest edit unless the caret is already there. */
export function goBack(ring, index, head) {
  if (!ring.length) return null;
  for (let k = 1; k <= ring.length; k++) {
    const i = (index + k) % ring.length;
    if (ring[i] !== head || ring.length === 1) return { index: i, pos: ring[i] };
  }
  return null;
}

/** What Repeat (F4) does → 'redo' when the history can redo, else 'repeat' when a repeatable command ran after the last typing,
 * else 'type' when there is typed text, else null (Can't Repeat). `cmd` is lastCommand(), `cmdAtTyping` what it was when the
 * typing ran. */
export function pickRepeat({ canRedo, cmd, cmdAtTyping, typed }) {
  if (canRedo) return 'redo';
  if (cmd && (cmd !== cmdAtTyping || !typed)) return 'repeat';
  if (typed) return 'type';
  return null;
}

/** An undo step's label from a summary of its first transaction: {command (a registry label), uiEvent, inserted (text), deleted,
 * marksOnly} → Word's wording. */
export function undoLabel({ command, uiEvent, inserted, deleted, marksOnly } = {}) {
  if (command) return command;
  if (uiEvent === 'paste' || uiEvent === 'drop') return 'Paste';
  if (uiEvent === 'cut') return 'Cut';
  if (marksOnly) return 'Formatting';
  // A long insertion shows its start: the label lands on a ribbon button and in the Undo list.
  if (inserted) return `Typing "${inserted.length > 40 ? `${inserted.slice(0, 40)}...` : inserted}"`;
  if (deleted) return 'Clear';
  return 'Edit';
}

/** The ranges of a column selection: one per line between `x1` and `x2` (either order). `lines` holds each line's positions as
 * [{pos, x}] in order, the position after the line's last character included → [{from, to}], empty lines left out. */
export function blockRanges(lines, x1, x2) {
  const [lo, hi] = x1 < x2 ? [x1, x2] : [x2, x1];
  const out = [];
  for (const line of lines) {
    const inside = line.filter((p) => p.x >= lo - 0.5 && p.x <= hi + 0.5);
    if (inside.length < 2) continue;
    out.push({ from: inside[0].pos, to: inside.at(-1).pos });
  }
  return out;
}
