// Click and Type zones (index-editing.md Typing and editing): where in the text column a double-click below the text lands
// decides the paragraph it makes. One table; the distances are unverified against Word. Pure.

export const ZONES = { centre: 36, right: 36, indentFrom: 18, indentTo: 36 };

/** A Click and Type double-click `x` pt from the text column's left edge in a column `width` pt wide → {kind: 'left' | 'center'
 * | 'right' | 'indent' | 'tab', at (pt from the left edge)}. */
export function zoneAt(x, width) {
  if (x < ZONES.indentFrom) return { kind: 'left', at: 0 };
  if (Math.abs(x - width / 2) <= ZONES.centre) return { kind: 'center', at: x };
  if (width - x <= ZONES.right) return { kind: 'right', at: x };
  if (x >= ZONES.indentFrom && x <= ZONES.indentTo) return { kind: 'indent', at: x };
  return { kind: 'tab', at: Math.max(0, x) };
}
