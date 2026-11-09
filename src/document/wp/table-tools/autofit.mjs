// Word's AutoFit rules the editor draws with (docs/plans/word/briefs/tables-insert.md). Pure, so the layout predictor and the unit
// test use them too.
// Word never makes a column of an AutoFit table (any w:tblLayout but fixed) narrower than its longest word: the Word fixture's 63
// column table asks for 0.25 in columns (w:tcW 360) in a 15.75 in table (w:tblW 22680), and Word draws its columns 1 to 9 at
// 17.25 pt and 10 to 63 at 23.65 pt, the width of "1" and "10" plus the cell margins, so the table runs past the margin.

/** The grid track of a column drawn `track` (a CSS track size) with a floor of `floor` px (its longest word and margins; 0 or
 * null for none). A share of a preferred width (`minmax(0, Nfr)`) keeps the share above the floor. */
export function floorTrack(track, floor) {
  if (!(floor > 0)) return track;
  const f = `${Math.ceil(floor * 100) / 100}px`;
  const m = /^minmax\((.+), (.+)\)$/.exec(track);
  // A bare 0 is a number inside max(), which would void the whole template.
  return m ? `minmax(max(${m[1] === '0' ? '0px' : m[1]}, ${f}), ${m[2]})` : `max(${track}, ${f})`;
}

/** Whether block `node` (ProseMirror JSON or node) is the empty paragraph that ends a cell right after a nested table: Word
 * draws it at no height (the fixture's nested tables: the outer row ends with the inner table's last border). `prev` is the
 * block before it, `last` whether it is the cell's last. */
export function hiddenCellEnd(node, prev, last) {
  const type = (n) => (typeof n?.type === 'string' ? n.type : n?.type?.name);
  const size = node?.content?.size ?? node?.content?.length ?? 0;
  return last && type(node) === 'paragraph' && size === 0 && type(prev) === 'table';
}
