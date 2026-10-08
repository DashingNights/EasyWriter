// Selection attachments for the assistant (SPEC §7i Attachments): what the user had selected when they asked, as a pill label for
// the chat and a text block for the model, each block capped so the 32 K context stays safe. Pure: capture.js reads the app.
// A message's `parts` are the chat box's content in order: strings and attachments {kind, label, body}.

export const ATTACH_CHARS = 2000;
const LINE = 120;

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 10)}... (cut)` : s);
const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
const plain = (html) => String(html ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const quoted = (s, n = 60) => `"${clip(s, n)}"`;
const attachment = (kind, label, body) => ({ kind, label, body: clip(body, ATTACH_CHARS) });

const SIDES = { n: 'top', s: 'bottom', e: 'right', w: 'left', ne: 'top right', nw: 'top left', se: 'bottom right', sw: 'bottom left', c: 'centre' };

/** The side of its item a connector end's `anchor` sits on, in words: an anchor name or [rx, ry] in 0..1 (as stored) → "bottom",
 * "top right", "centre"; null (floating, the end where the line to the other end crosses the outline) → "nearest side". In the
 * item's own frame. ponytail: a rotated shape's "bottom" is not the screen's; turn by its rot if that misleads a model. */
export function endSide(anchor) {
  if (anchor == null) return 'nearest side';
  if (typeof anchor === 'string') return SIDES[anchor] ?? anchor;
  const [dx, dy] = [anchor[0] - 0.5, anchor[1] - 0.5];
  const [h, v] = [dx < 0 ? 'left' : 'right', dy < 0 ? 'top' : 'bottom'];
  if (Math.abs(dx) > 0.4 && Math.abs(dy) > 0.4) return `${v} ${h}`;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 0.17) return 'centre';
  return Math.abs(dx) >= Math.abs(dy) ? h : v; // the box side, as flow/shapes.mjs portNormal picks it
}

/** A text selection (doc.selection: {path, from, to, text, context, toPath?}). */
export function textAttachment(sel) {
  const lines = sel.text.split('\n').filter((l) => l.trim()).length;
  const words = sel.text.split(/\s+/).filter(Boolean).length;
  const where = sel.toPath ? `blocks [${sel.path}] to [${sel.toPath}]` : `block [${sel.path}], characters ${sel.from} to ${sel.to}`;
  const around = sel.context && sel.context.trim() !== sel.text.trim() ? `\nIn context "${sel.context}"` : '';
  return attachment('text', lines > 1 ? `Selection: ${lines} lines` : `Selection: ${plural(words, 'word')}`,
    `Selected text in the draft, ${where}\n"${sel.text}"${around}`);
}

/** Board items as compact lines, each starting with the item's id (`first` > 0: numbered from `first` instead of "- ", the
 * legend form, whose numbers are the marks on the attachment's picture, marks.mjs); a connector names the items it joins by id,
 * label (looked up in `all`, the board's items) and the side each end sits on (endSide; a free end "(a point at 120,40)"), then
 * its route and bends as board_get's brief names them (bends: its waypoints): ", ortho, 2 bends", ", ortho, no bends", or
 * ", straight" for a straight one without bends; any other item its box in whole px (wave 2), " at 420,40 size 160x80" (a text
 * without a measured height: " width 240"). The ends, route, bends and box go after the cut, so they always show. */
export function itemLines(items, all = items, first = 0) {
  const byId = new Map(all.map((i) => [i.id, i]));
  const R = Math.round;
  const ok = Number.isFinite;
  const end = (e) => {
    if (typeof e?.item !== 'string') return `(a point${ok(e?.x) && ok(e?.y) ? ` at ${R(e.x)},${R(e.y)}` : ''})`;
    const i = byId.get(e.item);
    const label = i && plain(i.html);
    const side = endSide(e.anchor);
    return `${e.item}${label ? ` ${quoted(label, 40)} (${side})` : i ? ` (a ${i.type === 'shape' ? i.shape : i.type}, ${side})` : ` (${side})`}`;
  };
  const route = (c) => {
    const n = c.points?.length ?? 0;
    const r = c.route ?? 'ortho'; // flow/model.mjs cleanConnector's default
    return n ? `, ${r}, ${plural(n, 'bend')}` : r === 'straight' ? ', straight' : `, ${r}, no bends`;
  };
  const box = (i) => `${ok(i.x) && ok(i.y) ? ` at ${R(i.x)},${R(i.y)}` : ''}${!ok(i.w) ? '' : ok(i.h) ? ` size ${R(i.w)}x${R(i.h)}` : ` width ${R(i.w)}`}`;
  return items.map((i, k) => {
    const label = plain(i.html ?? i.labels?.mid?.html);
    const line = i.type === 'shape' ? `shape ${i.shape}${label ? ` ${quoted(label)}` : ''}`
      : i.type === 'text' ? `text ${quoted(label)}`
        : i.type === 'canvas' ? `canvas with ${plural(i.items?.length ?? 0, 'item')}`
          : i.type === 'connector' ? `connector${label ? ` ${quoted(label)}` : ''}`
            : i.type === 'stroke' ? 'pen stroke' : i.type;
    const after = i.type === 'connector' ? ` from ${end(i.from)} to ${end(i.to)}${route(i)}` : box(i);
    return `${first ? first + k : '-'} ${clip(`${i.id} ${line}`, LINE)}${after}`;
  }).join('\n');
}

/** `head`, then whole `lines` while the text fits ATTACH_CHARS, then "... and N more" for the item lines left out. */
export function listBody(head, lines) {
  const out = [head];
  let size = head.length;
  const more = (k) => `... and ${lines.slice(k).filter((l) => /^(-|\d+) /.test(l)).length} more`;
  for (let k = 0; k < lines.length; k++) {
    const room = k < lines.length - 1 ? more(k + 1).length + 1 : 0; // the more line, when lines are left after this one
    if (size + 1 + lines[k].length + room > ATTACH_CHARS) {
      out.push(more(k));
      break;
    }
    out.push(lines[k]);
    size += 1 + lines[k].length;
  }
  return out.join('\n');
}

export const OTHER_ITEMS = 'Other items on the board';

/** The legend order of a selection: the selected `items`, then the board's other items (`all`) in board order. */
export const boardOrder = (items, all) => {
  const ids = new Set(items.map((i) => i.id));
  return [...items, ...all.filter((i) => !ids.has(i.id))];
};

/** Items selected on a board (`where`: e.g. "the whiteboard at block [4]"; `all`: the board's items), in the legend form: the
 * selected ones numbered first, then OTHER_ITEMS and the rest in boardOrder (wave 2: the attachment's picture is the whole board
 * with these numbers on it, capture.js). */
export function itemsAttachment(items, where, all = items) {
  const rest = boardOrder(items, all).slice(items.length);
  const lines = [...itemLines(items, all, 1).split('\n'), ...(rest.length ? [OTHER_ITEMS, ...itemLines(rest, all, items.length + 1).split('\n')] : [])];
  return attachment('items', plural(items.length, 'item'), listBody(`${plural(items.length, 'selected item')} on ${where}`, lines));
}

const VIEW_NAMES = { kanban: 'Board', backlog: 'Backlog', gantt: 'Gantt' };

/** A node-selected block of `kind` (tool-rank.mjs blockKind, else its type) at `path`, with what describes it: `attrs.items` and
 * `mermaid` (a flowchart canvas: its item lines, then the Mermaid when the whole still fits ATTACH_CHARS), `flowTitle` (its
 * library flowchart), `plan` ({title, view, total, counts: [[column, n]], frozen}). A flowchart canvas, smart canvas or whiteboard
 * lists its items in the legend form (numbered as the marks on its picture), cut from the tail when long (listBody). */
export function blockAttachment(kind, { path, type, attrs = {}, mermaid = '', flowTitle = '', plan = null }) {
  const at = `at block [${path}] of the draft`;
  if (kind === 'flowchart') {
    const items = attrs.items ?? [];
    const from = flowTitle ? `, synced with the library flowchart ${quoted(flowTitle)},` : '';
    const head = `Flowchart canvas ${at}${from} with ${plural(items.length, 'item')}`;
    const lines = items.length ? itemLines(items, items, 1).split('\n') : [];
    const full = [head, ...lines, 'As Mermaid', mermaid].join('\n');
    return attachment('flowchart', 'Flowchart canvas', mermaid && full.length <= ATTACH_CHARS ? full : listBody(head, lines));
  }
  if (kind === 'image') {
    const img = attrs.items?.[0] ?? {};
    const src = String(img.src ?? '');
    const data = src.match(/^data:image\/([a-z0-9.+-]+);/i);
    const source = data ? `a pasted ${data[1].toUpperCase()} picture (${Math.round((src.length * 3) / 4 / 1024)} KB)` : clip(src, 200) || 'no source';
    return attachment('image', 'Image', `Image ${at}, ${Math.round(img.w ?? attrs.w)} x ${Math.round(img.h ?? attrs.h)} px, ${source}`);
  }
  if (kind === 'canvas' || kind === 'whiteboard') {
    const items = attrs.items ?? [];
    const label = kind === 'canvas' ? 'Smart canvas' : 'Whiteboard';
    return attachment(kind, label, listBody(`${label} ${at} with ${plural(items.length, 'item')}`, items.length ? itemLines(items, items, 1).split('\n') : []));
  }
  if (kind === 'planChart') {
    if (!plan) return attachment(kind, 'Plan chart', `Plan chart ${at}, its plan is gone`);
    const counts = plan.counts.map(([c, n]) => `${c} ${n}`).join(', ');
    return attachment(kind, 'Plan chart', `Plan chart ${at}${plan.frozen ? ' (a frozen copy)' : ''}, the plan ${quoted(plan.title)} in ${VIEW_NAMES[plan.view] ?? plan.view} view, `
      + `${plural(plan.total, 'ticket')}${counts ? ` (${counts})` : ''}`);
  }
  const name = type.replace(/([A-Z])/g, ' $1').toLowerCase();
  return attachment('block', name[0].toUpperCase() + name.slice(1), `A ${name} block ${at}`);
}

/** The display text of `parts`: an attachment as its label in brackets. */
export const partsText = (parts) => parts.map((p) => (typeof p === 'string' ? p : `[${p.label}]`)).join('');

/** What the model gets for a user message (wave 1c: the request last, where a small model looks for it): each attachment as a
 * labelled block, then `pictures` (OpenAI content parts: a caption and its picture each, assistant.js), then `note` (where it came
 * from), then "Request: " and the user's words: a pill among them as "[label]" ("Request: Make [Whiteboard] bigger", wave 2), the
 * pills before the first word left out (the auto-attached selection; the situation note's "Selected:" line names it); a message of
 * pills only keeps their labels. Text, or content parts with neighbouring texts joined (a chat template may trim each text part and
 * glue it to the next). The situation note goes before all of it (context.mjs withNote). */
export function modelContent(parts, note = '', pictures = []) {
  const blocks = parts.filter((p) => typeof p !== 'string').map((a) => `Attachment [${a.label}]\n${a.body}`);
  const lead = parts.findIndex((p) => typeof p === 'string' && p.trim());
  const words = (lead < 0 ? '' : parts.map((p, i) => (typeof p === 'string' ? p : i < lead ? '' : `[${p.label}]`)).join(''))
    .replace(/[ \t]+/g, ' ').trim() || partsText(parts).trim();
  const request = `${note ? `${note}\n\n` : ''}Request: ${words}`;
  if (!pictures.length) return [...blocks, request].join('\n\n');
  const out = [];
  for (const p of [...blocks.map((text) => ({ type: 'text', text })), ...pictures, { type: 'text', text: request }]) {
    if (p.type === 'text' && out.at(-1)?.type === 'text') out[out.length - 1] = { type: 'text', text: `${out.at(-1).text}\n\n${p.text}` };
    else out.push(p);
  }
  return out;
}
