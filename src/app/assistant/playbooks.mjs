// Playbooks for the assistant (SPEC §7i Playbooks; plan assistant-reliability.md waves 1b and 2b), like the SKILL.md files of
// coding agents: short numbered steps with example calls, what not to do and how to check, for the requests where the eval showed
// a 9B model's first call going wrong. pickPlaybooks puts at most two into the situation note of a turn (capture.js situation,
// under "How to do this:"), so they are in the first request with no lookup; commands.index {q} finds the rest by title. The tool
// text of the risky tools names its playbook by id (define.mjs guide.playbook, "Playbook: change-board-item"). Pure.
//
// A playbook (wave 2b, after the skill index of Figma's MCP): {id, title, triggers, when: {kinds?, views?, permission?}, text}.
// `triggers`, the phrases that select it (never shown to the model): a word or an adjacent phrase ('left of'), or an array of
// words that must all occur ('open', 'draft'); at least one must match the message. `kinds`: attachment kinds (attach.mjs);
// `views`: tool-set keys (tool-sets.mjs viewOf). A message with attachments needs one of `kinds` when the playbook lists any;
// otherwise a playbook that lists kinds or views needs one of them to hold. `permission`: 'readonly' = only in Read only mode,
// 'any' = in every mode, absent = not in Read only mode (its steps change things). `text`: a "Before:" line where a step must come
// first, the numbered steps, then a "Check:" line, what a fail looks like (for a board change, on the picture after the change).
// Keyboard characters only, at most about 300 tokens each.

const BOARD_KINDS = ['flowchart', 'canvas', 'whiteboard', 'items', 'image'];
const ITEM_LINES = 'the attachment, whose lines read "1 id type label at x,y size wxh"';
const NUMBERS = 'The numbers on the picture are the numbers of those lines.';
// situation-question: a question word with a thing the situation note names ("what flowchart is open", "which draft"); "open"
// counts too, so "what's the open draft called" outscores open-draft's open + draft.
const SITUATION_WORDS = ['what', "what's", 'which', 'where'].flatMap((q) => ['page', 'draft', 'drafts', 'thread', 'flowchart', 'plan', 'selected', 'selection', 'open']
  .map((noun) => [q, noun]));

export const PLAYBOOKS = [
  {
    id: 'change-board-item',
    title: 'Change or add an item on a board',
    triggers: ['change', 'straighten', 'straight', 'arrow', 'arrows', 'connector', 'line', 'colour', 'color', 'style', 'restyle', 'bigger',
      'smaller', 'resize', 'wider', 'taller', 'bend', 'bent', 'curve', 'curved', 'route', 'fill', 'dashed', 'dotted', 'thicker', 'thinner', 'flip', 'rotate',
      'add', 'draw', 'around'],
    when: { kinds: BOARD_KINDS, views: ['board'] },
    text: [
      'Before: if the situation note shows that canvas being edited, call canvas_close {} first.',
      '1. Take the board path from the attachment or the situation note, such as [4].',
      `2. Take the item id from ${ITEM_LINES}. ${NUMBERS} If it is not listed, call board_find {"path":[4],"q":"yes arrow"}.`,
      '3. To straighten an arrow, call board_items_straighten {"path":[4],"id":"c81hd0q"}. It also turns both ends to face each other. Else call board_items_update {"path":[4],"id":"k3j9x0a","patch":{"w":200}}. Colours go in color or fillColor, sizes in w and h.',
      '4. To add, call board_items_add {"path":[4],"items":[{"type":"text","html":"Note","x":40,"y":30,"w":240}]} with only the new items, placed by the boxes in the attachment. Leave colours out.',
      'Never call canvas_edit to change an item. It only opens Canvas Mode for drawing by hand.',
      'Check: the item in the result and on the picture after your change is as the request asked. If not, say what differs.',
    ].join('\n'),
  },
  {
    id: 'delete-board-item',
    title: 'Delete items from a board',
    triggers: ['delete', 'remove', 'erase', 'get rid', 'take out'],
    when: { kinds: BOARD_KINDS, views: ['board'] },
    text: [
      'Before: if board_items_remove is not in your tools, add it with commands_describe {"names":["board_items_remove"]}.',
      `1. Take the ids from ${ITEM_LINES}. Selected items are listed there. If they are not, call board_find {"path":[4],"q":"gearbox"}.`,
      '2. Call board_items_remove {"path":[4],"ids":["k3j9x0a"]} once, with every id in that one call.',
      '3. The user confirms on a card in the app. Do not ask in text. Never call canvas_edit for this.',
      'Check: the result and the picture after your change no longer have those items. If one is still there, say which.',
    ].join('\n'),
  },
  {
    id: 'move-board-item',
    title: 'Move an item on a board',
    triggers: ['move', 'drag', 'put', 'place', 'position', 'align', 'line up', 'left of', 'right of', 'above', 'below', 'under', 'next to', 'beside',
      'closer', 'nudge', 'shift'],
    when: { kinds: BOARD_KINDS, views: ['board'] },
    text: [
      `1. Take both ids from ${ITEM_LINES}. ${NUMBERS} If one is not listed, call board_find {"path":[4],"q":"tank"}.`,
      '2. Call board_items_place {"path":[4],"id":"k3j9x0a","relation":"left","of":"q2m1f8z"}. relation is left, right, above or below. The app works out x and y and lines up the edges.',
      '3. For any other place, call board_items_update {"path":[4],"id":"k3j9x0a","patch":{"x":40,"y":220}}.',
      'Check: the boxes in the result and the picture after your change put the item where the request asked. If not, say what differs.',
    ].join('\n'),
  },
  {
    id: 'rename-board-item',
    title: 'Change the text of an item on a board',
    triggers: ['rename', 'relabel', 'text', 'label', 'change the text', 'change the label', 'call it', 'name', 'wording', 'reword', 'says', 'say'],
    when: { kinds: BOARD_KINDS, views: ['board'] },
    text: [
      `1. Take the item id from ${ITEM_LINES}, or call board_find {"path":[4],"q":"pump"}. For an item named by its place, such as top left, call board_get {"path":[4]}. Top left has the smallest x and y.`,
      '2. Call board_items_update {"path":[4],"id":"k3j9x0a","patch":{"html":"Pump 2"}}. The text of a connector goes in {"labels":{"mid":{"html":"yes"}}}.',
      'Check: the label in the result and on the picture after your change reads as the request asked. If not, say what differs.',
    ].join('\n'),
  },
  {
    id: 'open-draft',
    title: 'Open a draft',
    triggers: [['open', 'draft'], ['switch', 'draft'], ['load', 'draft'], 'switch to'],
    when: {},
    text: [
      '1. Call drafts_list {} and pick the draft whose title matches. Leave threadUrl out.',
      '2. Call drafts_open {"draftId":"0b2c8f0e-1c4e-4f8a-9d6a-2b7f3c9e1a55"} with the id field of that draft. A draftId is never a title.',
      'When one title matches, open it without asking. Ask which one only when several match. If it is the open draft already, say so.',
      'Check: drafts_open answers without an error. If it fails, say why.',
    ].join('\n'),
  },
  {
    id: 'tag-draft',
    title: 'Set the tag of a draft',
    triggers: ['tag', 'tags', 'tagged', 'status', 'mark as'],
    when: {},
    text: [
      'Before: if drafts_setTag is not in your tools, call commands_describe {"names":["drafts_setTag","tags_list"]}.',
      '1. Call tags_list {} for the tag ids.',
      '2. Take the draft id from drafts_list {} (the open draft too).',
      '3. Call drafts_setTag {"draftId":"0b2c8f0e-1c4e-4f8a-9d6a-2b7f3c9e1a55","tagId":"done"}. tagId null clears the tag.',
      'Check: the result shows the new tagId. If it fails, say why.',
    ].join('\n'),
  },
  {
    id: 'edit-draft-text',
    title: 'Edit the text of the draft',
    triggers: ['reword', 'rewrite', 'add', 'insert', 'heading', 'paragraph', 'sentence', 'replace', 'delete', 'remove', 'fix', 'edit', 'write',
      'typo', 'shorten', 'expand', 'formal', 'bold', 'italic', 'list'],
    when: { kinds: ['text'], views: ['editor'] },
    text: [
      '1. Call doc_get {"format":"outline"} for the block paths. Block [0] is often the title. Count paragraphs by their type in the outline, not by path.',
      '2. Change blocks by path. doc_replace {"path":[1],"content":{"markdown":"New text."}} rewrites one block. doc_insert {"at":[3],"position":"before","content":{"markdown":"## Heading"}} adds blocks.',
      '3. Use the paths of your last read. After a stale error, read the outline again.',
      'For several changes, read once, then run one batch.',
      'Check: the paths in the result are the blocks the request named. If not, say what differs.',
    ].join('\n'),
  },
  {
    id: 'picture-question',
    title: 'Answer from the attached picture',
    triggers: ['picture', 'image', 'photo', 'see', 'look', 'boxes', 'bbox', 'json', 'where', 'colour', 'color', 'what', 'describe', 'how many',
      'count', 'show', 'shows', 'coordinates', 'which', 'what would'],
    when: { kinds: ['image', 'canvas', 'whiteboard', 'flowchart'], permission: 'any' },
    text: [
      'The picture after the message shows the attached block. Answer from it and from the text of the attachment.',
      '1. Call no tool. Reading the draft or opening Canvas Mode shows you nothing more.',
      '2. For boxes, reply with JSON such as [{"label":"red circle","bbox_2d":[x1,y1,x2,y2]}].',
      'Never say you cannot see the picture.',
      'Check: name only what the picture or the attachment shows. If they do not show it, say so.',
    ].join('\n'),
  },
  {
    id: 'read-only',
    title: 'Read only mode',
    triggers: ['change', 'rename', 'move', 'delete', 'remove', 'add', 'insert', 'straighten', 'edit', 'set', 'tag', 'write', 'rewrite', 'reword',
      'fix', 'replace', 'create', 'format', 'resize', 'put', 'update', 'draw'],
    when: { permission: 'readonly' },
    text: [
      'The assistant is in Read only mode, so every change is refused.',
      '1. Say plainly that you are in Read only mode and cannot change anything.',
      '2. Say in one sentence what you would do, such as rename the shape Gearbox to Gearbox A.',
      '3. Say that Read only mode can be turned off in Settings.',
      'Call no tool for the change. Do not look for another tool with commands_index. Reads to answer a question still work.',
      'Check: your reply does not say that anything changed.',
    ].join('\n'),
  },
  {
    // Wave 1c: Gemma made up tool names for "What is the title of the flowchart that is open?", which the note answers.
    id: 'situation-question',
    title: 'Answer a question about what is open or selected',
    triggers: SITUATION_WORDS,
    when: { permission: 'any' },
    text: [
      'The situation note names the page, the open draft, its thread, the open flowchart or plan, what is selected and the drafts.',
      '1. Answer from the situation note. Call no tool.',
      '2. Name drafts and flowcharts by their titles.',
      'Only for what the draft or a board says inside, read it with doc_get or board_get.',
      'Check: every title in your reply is in the situation note.',
    ].join('\n'),
  },
  {
    id: 'canvas-mode',
    title: 'Open Canvas Mode for drawing by hand',
    triggers: ['canvas mode', 'by hand', 'freehand', 'sketch', 'myself', 'let me draw', 'i want to draw', ['open', 'canvas'], ['edit', 'canvas']],
    when: { kinds: ['canvas', 'flowchart', 'image', 'whiteboard'], views: ['editor', 'board'] },
    text: [
      'Use this only when the user asks to draw or edit by hand.',
      '1. Call canvas_edit {"path":[4]} for a canvas block, or {"path":[6],"item":"k3j9x0a"} for a picture or canvas item on a whiteboard. {} opens the selected one.',
      '2. Tell the user it is open and that Done closes it.',
      'To change items, do not open Canvas Mode. Use board_find and board_items_update.',
      'Check: canvas_edit answers without an error. If it fails, say why.',
    ].join('\n'),
  },
];

const MAX_PICKED = 2;
const norm = (s) => ` ${String(s).toLowerCase().replace(/[^a-z0-9']+/g, ' ').trim()} `;
const has = (t, w) => (Array.isArray(w) ? w.every((x) => t.includes(` ${x} `)) : t.includes(` ${w} `));
const weight = (w) => (Array.isArray(w) ? w.length : w.split(' ').length);

/** Whether playbook `p` applies in permission mode `permission` (when.permission, header). */
export const allowed = (p, permission) => (permission === 'readonly' ? !!p.when.permission : p.when.permission !== 'readonly');

/** What the steps of playbook `p` do: 'answer' (a `when.permission`: picture-question, read-only and situation-question call no
 * tool), 'hand' (canvas-mode calls canvas_edit, which the board playbooks never call for a change; wave 2b review: "let me draw"
 * also hits change-board-item's draw) or 'change'. Only playbooks that do the same are paired. */
const does = (p) => (p.when.permission ? 'answer' : p.id === 'canvas-mode' ? 'hand' : 'change');

/** At most 2 playbooks for a message: `text` (default: the strings of `parts`), `parts` (its attachments give the kinds),
 * `view` (the tool-set key), `permission`. Each matched trigger scores 3 per word, a matching attachment kind 2, the view 1; no
 * matched trigger, no playbook ("hello" gets none). A second one only scores at least half the first and does the same (does). */
export function pickPlaybooks({ text, parts = [], view = '', permission = 'standard' }) {
  const t = norm(text ?? parts.filter((p) => typeof p === 'string').join(' '));
  const kinds = parts.filter((p) => p && typeof p === 'object').map((p) => p.kind);
  const scored = PLAYBOOKS.flatMap((p) => {
    const { kinds: ks = [], views = [] } = p.when;
    if (!allowed(p, permission)) return [];
    const hit = p.triggers.filter((w) => has(t, w)).reduce((n, w) => n + weight(w), 0);
    const kind = ks.some((k) => kinds.includes(k));
    const inView = views.includes(view);
    const fits = kinds.length && ks.length ? kind : (!ks.length && !views.length) || kind || inView;
    return hit && fits ? [{ p, score: 3 * hit + (kind ? 2 : 0) + (inView ? 1 : 0) }] : [];
  }).sort((a, b) => b.score - a.score);
  return scored.filter((s, i) => i < MAX_PICKED && s.score * 2 >= scored[0].score && does(s.p) === does(scored[0].p)).map((s) => s.p);
}

/** commands.index {q}: the playbooks whose title or triggers hold every word of `q` longer than 2 letters (as substrings; a
 * playbook id such as change-board-item is found by its words), at most 2, among those `permission` allows → [{id, title, text}]. */
export function findPlaybooks(q, permission = 'standard') {
  const words = String(q).toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 2);
  if (!words.length) return [];
  return PLAYBOOKS.filter((p) => allowed(p, permission) && words.every((w) => `${p.id} ${p.title} ${p.triggers.flat().join(' ')}`.toLowerCase().includes(w)))
    .slice(0, MAX_PICKED).map(({ id, title, text }) => ({ id, title, text }));
}
