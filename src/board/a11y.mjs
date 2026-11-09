// bd-a11y (docs/plans/board/briefs/bd-a11y.md): what a screen reader says for a board item, and the order a board reads in.
// Pure, so the node test and the reader read the same words. `titleOf(id)` names a draft (a document's title) or an item (a
// connector's ends); `store` is only needed for a group's children, which a group does not store.
import { boxOf } from './gestures.mjs';
import { plainOf, toPx } from './look.mjs';
import { readingOrder } from './sections.mjs';
import { nameOf } from './tools/layers.js';

const px = (pt) => Math.round(toPx(pt ?? 0));
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/** The row's text for `item`: its shape and size, text, description, ends, members or pages, and `, locked` at the end. A
 * hidden item is left out (''). */
export function describe(item, titleOf, store = null) {
  if (!item || item.gone || item.hidden) return '';
  let line;
  switch (item.type) {
    case 'shape':
    case 'ink': {
      const text = oneLine(plainOf(item.story));
      line = `${nameOf(item)}, ${px(item.w)} by ${px(item.h)}${text ? `, ${text}` : ''}`;
      break;
    }
    case 'text': {
      const text = oneLine(plainOf(item.story)).slice(0, 200);
      line = text ? `Text, ${text}` : 'Text';
      break;
    }
    case 'picture': {
      const alt = oneLine(item.alt);
      line = alt ? `Picture, ${alt}` : 'Picture, no description';
      break;
    }
    case 'connector': {
      const end = (e) => (e?.item ? titleOf?.(e.item) ?? 'an item' : 'a point');
      line = `Connector from ${end(item.from)} to ${end(item.to)}`;
      break;
    }
    case 'group':
      line = `Group of ${store ? store.children(item.id).length : 0}`;
      break;
    case 'doc':
      line = `${titleOf?.(item.draft) ?? 'Document'}, document, ${item.summary?.count ?? 0} pages`;
      break;
    default:
      line = nameOf(item);
  }
  return item.locked ? `${line}, locked` : line;
}

/** The ids of the top-level items in reading order: `readingOrder` over their boxes, hidden items and groups with no children
 * left out. */
export function readingList(store) {
  const ids = [];
  const boxes = [];
  for (const item of store.children(null)) {
    if (!item || item.hidden) continue;
    const box = boxOf(item, store);
    if (!box) continue;
    ids.push(item.id);
    boxes.push(box);
  }
  return readingOrder(boxes).map((k) => ids[k]);
}
