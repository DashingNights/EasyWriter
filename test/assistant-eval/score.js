'use strict';
// Scoring for the assistant eval (run.js; docs/plans/assistant-reliability.md §3 Wave 0). Pure, no Electron.
// `node test/assistant-eval/score.js` (or `node --test test/assistant-eval/score.js`) runs its self-check.

// A reply that claims or promises an action. Our own list, not the app's (context.mjs), so the eval also catches what the
// app's check lets through.
const VERBS = 'opened|changed|added|deleted|removed|created|updated|inserted|replaced|renamed|moved|edited|saved|formatted|tagged|set|straightened|made|fixed|done|resized|enlarged';
const CLAIM = new RegExp(`(?:^|[.!?,]\\s+)\\s*[*_]*I(?:'ve|’ve| have)?\\s+(?:now\\s+|just\\s+|also\\s+)?(?:${VERBS})\\b|\\b(?:has|have) been (?:${VERBS})\\b|^\\s*[*_]*(?:all\\s+)?done\\b`, 'im');
const PROMISE = /\b(?:I'll|I’ll|I will|I'm going to|I am going to|let me (?!know\b))/i;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Whether `v` matches pattern `p`: objects key by key (other keys allowed), arrays element by element (same length), other
 * values by ===; operator objects {$any: [p]}, {$all: [p]}, {$regex: s} (case-insensitive; a non-string is matched as its
 * JSON), {$has: [keys]} (an object with at least one of them), {$some: p} (an array with at least one element matching p),
 * {$lt: n}, {$gt: n}, {$ne: v}. */
function matches(p, v) {
  if (isObj(p)) {
    const [k, x] = Object.entries(p)[0] ?? [];
    if (k === '$any') return x.some((q) => matches(q, v));
    if (k === '$all') return x.every((q) => matches(q, v));
    if (k === '$regex') return new RegExp(x, 'i').test(typeof v === 'string' ? v : JSON.stringify(v) ?? '');
    if (k === '$has') return isObj(v) && x.some((key) => key in v);
    if (k === '$some') return Array.isArray(v) && v.some((e) => matches(x, e));
    if (k === '$lt') return typeof v === 'number' && v < x;
    if (k === '$gt') return typeof v === 'number' && v > x;
    if (k === '$ne') return v !== x;
    return isObj(v) && Object.entries(p).every(([key, q]) => matches(q, v[key]));
  }
  if (Array.isArray(p)) return Array.isArray(v) && p.length === v.length && p.every((q, i) => matches(q, v[i]));
  return p === v;
}

// ---------------------------------------------------------------------------------------------
// Boxes (the grounding case): the reply's JSON → {label: [x1, y1, x2, y2]}, compared with the fixture's boxes under each
// coordinate convention; the best one is reported.

function boxOf(v) {
  if (Array.isArray(v) && v.length === 2 && v.every((p) => Array.isArray(p) && p.length === 2)) v = v.flat();
  if (Array.isArray(v) && v.length === 4 && v.every(Number.isFinite)) return v;
  if (!isObj(v)) return null;
  for (const k of ['bbox_2d', 'box_2d', 'bbox', 'box', 'coordinates', 'coords']) if (v[k] !== undefined) return boxOf(v[k]);
  if ([v.x1, v.y1, v.x2, v.y2].every(Number.isFinite)) return [v.x1, v.y1, v.x2, v.y2];
  if ([v.xmin, v.ymin, v.xmax, v.ymax].every(Number.isFinite)) return [v.xmin, v.ymin, v.xmax, v.ymax];
  const w = v.w ?? v.width;
  const h = v.h ?? v.height;
  if ([v.x, v.y, w, h].every(Number.isFinite)) return [v.x, v.y, v.x + w, v.y + h];
  return null;
}

/** The first JSON value in `text` (fenced or not) → [{label, box}]; [] when there is none. */
function parseBoxes(text) {
  const s = String(text ?? '').replace(/```(?:json)?/gi, '');
  let json = null;
  for (let i = 0; i < s.length && json === null; i++) {
    if (s[i] !== '[' && s[i] !== '{') continue;
    const close = s[i] === '[' ? ']' : '}';
    for (let j = s.lastIndexOf(close); j > i && json === null; j = s.lastIndexOf(close, j - 1)) {
      try {
        json = JSON.parse(s.slice(i, j + 1));
      } catch {}
    }
  }
  if (json === null) return [];
  const label = (o) => String(o.label ?? o.name ?? o.object ?? o.shape ?? o.description ?? '');
  if (Array.isArray(json)) return json.filter(isObj).map((o) => ({ label: label(o), box: boxOf(o) })).filter((b) => b.box);
  if (isObj(json)) {
    const list = Object.values(json).find((v) => Array.isArray(v) && v.some(isObj));
    if (list) return list.filter(isObj).map((o) => ({ label: label(o), box: boxOf(o) })).filter((b) => b.box);
    return Object.entries(json).map(([k, v]) => ({ label: k, box: boxOf(v) })).filter((b) => b.box);
  }
  return [];
}

const iou = (a, b) => {
  const [ax1, ay1, ax2, ay2] = [Math.min(a[0], a[2]), Math.min(a[1], a[3]), Math.max(a[0], a[2]), Math.max(a[1], a[3])];
  const w = Math.min(ax2, b[2]) - Math.max(ax1, b[0]);
  const h = Math.min(ay2, b[3]) - Math.max(ay1, b[1]);
  const inter = w > 0 && h > 0 ? w * h : 0;
  const union = (ax2 - ax1) * (ay2 - ay1) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
};

/** Compares the boxes in `reply` with `shapes` ({size: [w, h], shapes: [{label, kind, box}]}); `sent` = the pixel size of the
 * picture the model got (or null). → {pass, convention, iou: {label: n}, note}. */
function scoreBoxes(reply, shapes, sent, minIoU) {
  const [w, h] = shapes.size;
  const found = parseBoxes(reply);
  if (!found.length) return { pass: false, convention: null, iou: {}, note: 'no JSON boxes in the reply' };
  const conventions = [
    ['normalised 0-1000', (b) => [b[0] * w / 1000, b[1] * h / 1000, b[2] * w / 1000, b[3] * h / 1000]],
    ['normalised 0-1', (b) => [b[0] * w, b[1] * h, b[2] * w, b[3] * h]],
    [`pixels of the image (${w} x ${h})`, (b) => b],
    ...(sent && (sent[0] !== w || sent[1] !== h) ? [[`pixels of the sent picture (${sent[0]} x ${sent[1]})`, (b) => [b[0] * w / sent[0], b[1] * h / sent[1], b[2] * w / sent[0], b[3] * h / sent[1]]]] : []),
  ];
  const pick = (s) => found.find((f) => new RegExp(`\\b${s.kind}\\b`, 'i').test(f.label)) ?? found.find((f) => new RegExp(s.label.split(' ')[0], 'i').test(f.label));
  let best = null;
  for (const [name, map] of conventions) {
    const ious = Object.fromEntries(shapes.shapes.map((s) => {
      const f = pick(s);
      return [s.label, f ? Math.round(iou(map(f.box), s.box) * 100) / 100 : 0];
    }));
    const mean = Object.values(ious).reduce((a, b) => a + b, 0) / shapes.shapes.length;
    if (!best || mean > best.mean) best = { convention: name, iou: ious, mean };
  }
  const pass = Object.values(best.iou).every((v) => v >= minIoU);
  return { pass, convention: best.convention, iou: best.iou, note: `boxes as ${best.convention}, IoU ${Object.entries(best.iou).map(([k, v]) => `${k} ${v}`).join(', ')}` };
}

// ---------------------------------------------------------------------------------------------
// Drafts and boards after the turn (the doc checks; the annotation case).

/** A draft's doc JSON → its top-level blocks, empty paragraphs left out (the editor's trailing one): {type, text, firstBold?: the
 * bold text the block starts with, flow?: a synced canvas's flowchart id, items?: a board's items, lines?: a list's item texts}. */
function blocks(doc) {
  const text = (n) => n.text ?? (n.content ?? []).map(text).join('');
  return (doc?.content ?? []).filter((n) => n.type !== 'paragraph' || text(n).trim()).map((n) => {
    const lead = [];
    for (const t of n.content ?? []) {
      if (!t.marks?.some((m) => m.type === 'bold')) break;
      lead.push(t.text ?? '');
    }
    return { type: n.type, text: text(n), ...(lead.length && { firstBold: lead.join('') }), ...(n.attrs?.flow?.id && { flow: n.attrs.flow.id }),
      ...(Array.isArray(n.attrs?.items) && { items: n.attrs.items }), ...(/List$/.test(n.type) && { lines: (n.content ?? []).map(text) }) };
  });
}

const plain = (i) => String(i?.html ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const names = (o) => new RegExp(`\\b(?:${o.names.join('|')})s?\\b`, 'i');

/** Thing `label` of `scene` ({objects: [{label, names, box}]}) on the first whiteboard of `doc` (blocks): marked when a shape's box
 * has IoU >= minIoU with the thing's box (board coordinates), labelled when an item whose text names it (not a mark, not a
 * connector) is joined to such a shape by a connector (an end on the item, or a free end within 16 px of its box).
 * → {credit: 0 | 0.5 (marked) | 1 (marked and labelled), note}. */
function scoreMark(doc, scene, label, minIoU = 0.3) {
  const o = scene.objects.find((x) => x.label === label);
  const items = (doc ?? []).find((b) => b.type === 'whiteboard')?.items ?? [];
  const marks = items.filter((i) => i.type === 'shape' && iou([i.x, i.y, i.x + i.w, i.y + i.h], o.box) >= minIoU);
  if (!marks.length) return { credit: 0, note: `${label} not marked (no shape with IoU ${minIoU} or more)` };
  const texts = items.filter((i) => i.type !== 'connector' && !marks.includes(i) && names(o).test(plain(i)));
  const near = (e, i) => e?.x >= i.x - 16 && e.x <= i.x + i.w + 16 && e.y >= i.y - 16 && e.y <= i.y + (i.h ?? 40) + 16;
  const at = (e, i) => (typeof e?.item === 'string' ? e.item === i.id : near(e, i));
  const joined = items.some((c) => c.type === 'connector' && marks.some((m) => texts.some((t) => (at(c.from, m) && at(c.to, t)) || (at(c.from, t) && at(c.to, m)))));
  return joined ? { credit: 1, note: '' } : { credit: 0.5, note: `${label} marked, not labelled (${texts.length ? 'no connector joins its label to the mark' : 'no text names it'})` };
}

/** null when a paragraph after the first whiteboard of `doc` (blocks) has `sentences` sentences and names at least `need` of the
 * scene's things; else what is missing. */
function scoreSummary(doc, scene, sentences = 2, need = 3) {
  const d = doc ?? [];
  const wb = d.findIndex((b) => b.type === 'whiteboard');
  const count = (t) => (t.match(/[.!?]+(?=["')\]]*(?:\s|$))/g) ?? []).length;
  const found = (t) => scene.objects.filter((o) => names(o).test(t)).length;
  const after = wb < 0 ? [] : d.slice(wb + 1).filter((b) => b.type === 'paragraph');
  if (after.some((b) => count(b.text) === sentences && found(b.text) >= need)) return null;
  return `no paragraph after the whiteboard with ${sentences} sentences naming ${need} of the ${scene.objects.length} things${after.length ? ` (${after.map((b) => `${count(b.text)} sentences naming ${found(b.text)}`).join('; ')})` : ''}`;
}

// The user's own annotations, removed from a fixture copy of their post, drawn again (eval set 4). `truth` = a truth file:
// {kept: the board's item ids in the copy (the first one finds the board; any other item is added), removed: the user's items,
// after?: the texts of the blocks after the board, notes?: {word: note id}, ellipses?: {id: {names?, alsoBox?}}}.

const itemBox = (i) => [i.x, i.y, i.x + (i.w ?? 0), i.y + (i.h ?? 40)]; // a text item stores no height
const gapOf = (a, b) => Math.hypot(Math.max(0, a[0] - b[2], b[0] - a[2]), Math.max(0, a[1] - b[3], b[1] - a[3]));
// truth.canvas (eval set 5): the marks sit in that canvas item of the whiteboard, in its artboard's coordinates.
const boardAt = (doc, truth) => (doc ?? []).findIndex((b) => b.type === 'whiteboard' && b.items?.some((i) => i.id === (truth.canvas ?? truth.kept[0])));
const itemsOn = (doc, truth) => {
  const items = doc?.[boardAt(doc, truth)]?.items ?? [];
  return truth.canvas ? items.find((i) => i.id === truth.canvas)?.items ?? [] : items;
};
const addedOn = (doc, truth) => itemsOn(doc, truth).filter((i) => !truth.kept.includes(i.id));

/** Item `id` of truth.removed marked again: an added shape of one of `kinds` whose box has IoU >= minIoU with the item's box (or
 * truth.ellipses[id].alsoBox). With `within`: labelled when an added item (the mark itself too) whose text names it
 * (truth.ellipses[id].names, as word starts) lies within `within` px of such a mark, the gap between the boxes.
 * → {credit: 0 | 0.5 (marked, not labelled) | 1, note}. */
function scoreShape(doc, truth, { id, kinds, minIoU = 0.25, within }) {
  const t = truth.removed.find((i) => i.id === id);
  const boxes = [itemBox(t), truth.ellipses?.[id]?.alsoBox].filter(Boolean);
  const added = addedOn(doc, truth);
  const marks = added.filter((i) => i.type === 'shape' && kinds.includes(i.shape) && boxes.some((b) => iou(itemBox(i), b) >= minIoU));
  if (!marks.length) return { credit: 0, note: `${id} not marked (no added ${kinds.join(' or ')} with IoU ${minIoU} or more)` };
  if (within === undefined) return { credit: 1, note: '' };
  const { names } = truth.ellipses[id];
  const re = new RegExp(`\\b(?:${names.join('|')})`, 'i');
  if (added.some((i) => re.test(plain(i)) && marks.some((m) => gapOf(itemBox(i), itemBox(m)) <= within))) return { credit: 1, note: '' };
  return { credit: 0.5, note: `${id} marked, no added text naming it (${names.join(', ')}) within ${within} px` };
}

const deg = (dx, dy) => ((((Math.atan2(dy, dx) * 180) / Math.PI) % 180) + 180) % 180;

/** An item's centre and direction (degrees, 0 to 180), or null: a line or arrow shape runs corner to corner (flipX / flipY mirror
 * it), a connector with two free ends end to end, another shape at least twice as long as wide along its longer side (a lane
 * drawn as a thin box; the mid box is not a lane); rot turns it. ponytail: strokes are not read, add when a model draws lanes
 * freehand. */
function axisOf(i) {
  if (i.type === 'connector') {
    const [f, t] = [i.from, i.to];
    return [f?.x, f?.y, t?.x, t?.y].every(Number.isFinite) ? { c: [(f.x + t.x) / 2, (f.y + t.y) / 2], a: deg(t.x - f.x, t.y - f.y) } : null;
  }
  if (i.type !== 'shape' || ![i.x, i.y, i.w, i.h].every(Number.isFinite)) return null;
  const lineish = i.shape === 'line' || i.shape === 'arrow';
  if (!lineish && Math.max(i.w, i.h) < 2 * Math.min(i.w, i.h)) return null;
  const a = lineish ? deg(i.flipX ? -i.w : i.w, i.flipY ? -i.h : i.h) : i.w >= i.h ? 0 : 90;
  return { c: [i.x + i.w / 2, i.y + i.h / 2], a: (((a + (i.rot ?? 0)) % 180) + 180) % 180 };
}

/** Line `id` of truth.removed drawn again: an added item (axisOf) whose centre lies within `dist` px of the line's centre and
 * whose direction is within `angle` degrees of the line's. → {credit: 0 | 1, note}. */
function scoreLine(doc, truth, { id, dist = 60, angle = 30 }) {
  const t = axisOf(truth.removed.find((i) => i.id === id));
  const off = (a) => Math.min(Math.abs(a - t.a), 180 - Math.abs(a - t.a));
  const near = addedOn(doc, truth).map(axisOf).filter((x) => x && Math.hypot(x.c[0] - t.c[0], x.c[1] - t.c[1]) <= dist);
  if (near.some((x) => off(x.a) <= angle)) return { credit: 1, note: '' };
  return { credit: 0, note: `${id} not drawn (${near.length ? `${near.length} added near its centre, none within ${angle} degrees of it` : `nothing added within ${dist} px of its centre`})` };
}

/** Lines `ids` of truth.removed drawn again (scoreLine each) → {credit: the share drawn, note}. */
function scoreLines(doc, truth, { ids, dist, angle }) {
  const missed = ids.map((id) => scoreLine(doc, truth, { id, dist, angle })).filter((r) => !r.credit).map((r) => r.note);
  return { credit: (ids.length - missed.length) / ids.length, note: missed.join('; ') };
}

/** A #rrggbb colour's hue (degrees), saturation and lightness (0 to 1), or null. */
function hsl(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex ?? ''));
  if (!m) return null;
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255);
  const [hi, lo] = [Math.max(r, g, b), Math.min(r, g, b)];
  const l = (hi + lo) / 2;
  const d = hi - lo;
  const sat = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  const h = !d ? 0 : hi === r ? ((g - b) / d) % 6 : hi === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: sat, l };
}

/** The added shapes and connectors in the hue `hue` (within `within` degrees, saturation 0.45 or more, lightness 0.2 to 0.8):
 * the page's marking colour kept. → {credit: their share, note}; nothing added scores 0. */
function scoreColour(doc, truth, { hue, within = 25 }) {
  const marks = addedOn(doc, truth).filter((i) => i.type === 'shape' || i.type === 'connector');
  if (!marks.length) return { credit: 0, note: 'no shape or connector added' };
  const off = marks.filter((i) => {
    const c = hsl(i.color);
    return !c || c.s < 0.45 || c.l < 0.2 || c.l > 0.8 || Math.min(Math.abs(c.h - hue), 360 - Math.abs(c.h - hue)) > within;
  });
  return { credit: (marks.length - off.length) / marks.length, note: off.length ? `${off.length} of ${marks.length} marks not in hue ${hue} (${[...new Set(off.map((i) => i.color))].join(', ')})` : '' };
}

/** The added text items with a background in `bg` (the user's note colours) → {credit: their share, note}; none added scores 0. */
function scoreNoteBg(doc, truth, { bg }) {
  const notes = addedOn(doc, truth).filter((i) => i.type === 'text');
  if (!notes.length) return { credit: 0, note: 'no text item added' };
  const off = notes.filter((i) => !bg.includes(String(i.bg).toLowerCase()));
  return { credit: (notes.length - off.length) / notes.length, note: off.length ? `${off.length} of ${notes.length} notes without the note background ${bg.join(' or ')} (${[...new Set(off.map((i) => i.bg))].join(', ')})` : '' };
}

/** Every item of the board holding item `board` in fixture draft `draft` (but `except`) is still there, unchanged, after the turn
 * (items added beside them are fine) → {credit: 0 | 1, note}. */
function scoreSame(doc, fixture, { draft, board, except = [] }) {
  const find = (d) => (d ?? []).find((b) => b.type === 'whiteboard' && b.items?.some((i) => i.id === board))?.items ?? [];
  // The app's own touches are not changes: a text item's measured height (settle stores it), an image's data (result.json strips it).
  const norm = ({ src, h, items, ...i }) => JSON.stringify({ ...i, ...(i.type !== 'text' && h !== undefined && { h }), ...(items && { items: items.map(norm) }) });
  const now = new Map(find(doc).map((i) => [i.id, norm(i)]));
  const changed = find(blocks(fixture(`drafts/${draft}.json`).doc)).filter((i) => !except.includes(i.id) && now.get(i.id) !== norm(i));
  return changed.length ? { credit: 0, note: `${changed.length} item(s) of the exemplar board changed or gone (${changed.slice(0, 4).map((i) => i.id).join(', ')})` } : { credit: 1, note: '' };
}

/** The most of the patterns `res` that distinct texts match, one text each → their indexes. */
function cover(texts, res) {
  let best = [];
  const go = (k, used, got) => {
    if (got.length > best.length) best = got;
    if (k === res.length) return;
    texts.forEach((t, j) => { if (!used.includes(j) && res[k].test(t)) go(k + 1, [...used, j], [...got, k]); });
    go(k + 1, used, got);
  };
  go(0, [], []);
  return best;
}

/** The note on `word` (a key of truth.notes, matched as a word start, or after an "a": asymmetrical) written anew: the new texts are the added board items' texts
 * and the blocks after the board that truth.after lacks (a list's items one by one); each text counts for one word, the most
 * words counted, so one note naming all the words counts once. → {credit: 0 | 1, note}. */
function scoreNote(doc, truth, { word }) {
  const at = boardAt(doc, truth);
  const after = at < 0 ? [] : doc.slice(at + 1).filter((b) => !truth.after.includes(b.text)).flatMap((b) => b.lines ?? [b.text]);
  const texts = [...addedOn(doc, truth).map(plain), ...after].filter((s) => s.trim());
  const words = Object.keys(truth.notes);
  const got = cover(texts, words.map((w) => new RegExp(`\\ba?${w}`, 'i')));
  if (got.includes(words.indexOf(word))) return { credit: 1, note: '' };
  return { credit: 0, note: `no new note on ${word} (${texts.length} new texts${got.length ? `, they count for ${got.map((k) => words[k]).join(', ')}` : ''})` };
}

const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------------------------

/** One case's outcome. `turn` = {calls: [{name, args, ran, ok, risk, result?}], reply, errors: [string], sent?: [w, h], doc?: blocks()
 * of the open draft after the turn, docs?: {draftId: blocks()}}; `x` = the case's expect (a call's `name` may be a pattern too, {$any:
 * [names]}; `anyOrder`: each expected call may be any call, one call may meet several; `doc`: a pattern for turn.doc, or for
 * turn.docs[draft] with `draft`; `mark` {fixture, object, minIoU} and `summary` {fixture, sentences, names}: the annotation checks;
 * on a copy of the user's board (truth: a truth file, the same doc as `doc`): `shape` {truth, id, kinds, minIoU, within?}, `line`
 * {truth, id, dist, angle}, `note` {truth, word}; eval set 5: `lines` {truth, ids, dist, angle} (the share drawn), `colour` {truth,
 * hue, within} (the share of added marks in that hue), `noteBg` {truth, bg: [colours]} (the share of added notes with such a
 * background), `same` {draft, board, except} (the exemplar board's items unchanged); truth.canvas: the marks sit in that canvas
 * item of the board; `typed`: true, the doc's last block ends with turn.typed (the words the runner
 * typed into the editor during the turn, typeWhileRunning); `viewStays`: true, turn.openAfter (the open draft after the turn) is
 * turn.openBefore; `steps` [{name, check, expectedFail?}]: each check an expect of its own, scored apart (below)); `fixture(name)`
 * reads a fixture JSON.
 * → {pass, fails: [string], credit (0 to 1; mark and shape give 0.5 for a mark without its label), last (the index of the last call
 * the expected calls met, -1 for none), boxes?}; a stepped case → {pass, fails, score (0 to 100), steps: [{name, credit, note,
 * expectedFail?}], boxes?}. */
/** `turn` with each batch's steps as calls of their own right after it (`inner`), once: a batch that does several expected
 * things meets them all, and `never` sees inside it; maxCalls counts the batch once. */
function expandBatches(turn) {
  if (turn.expanded) return turn;
  return { ...turn, expanded: true, calls: turn.calls.flatMap((c) => [c, ...(c.name === 'batch' && Array.isArray(c.args?.steps) ? c.args.steps.map((s, k) => {
    const res = c.result?.results?.[k];
    return { name: String(s?.id).replaceAll('.', '_'), args: s?.args ?? {}, ok: c.ok && !res?.error, risk: c.risk, inner: true, ...(res && !res.error && { result: res }) };
  }) : [])]) };
}

function score(x, turn, fixture) {
  if (x.steps) return scoreSteps(x, turn, fixture);
  turn = expandBatches(turn);
  const fails = [];
  let i = 0;
  let last = -1;
  for (const e of x.calls ?? []) {
    const want = e.ok ?? true;
    const k = turn.calls.findIndex((c, j) => j >= (x.anyOrder ? 0 : i) && matches(e.name, c.name) && c.ok === want && matches(e.args ?? {}, c.args)
      && (!e.result || matches(e.result, c.result)));
    if (k < 0) {
      fails.push(`no ${want ? 'successful ' : ''}${typeof e.name === 'string' ? e.name : JSON.stringify(e.name)}${e.args ? ` matching ${JSON.stringify(e.args)}` : ''}${e.result ? ` with a result matching ${JSON.stringify(e.result)}` : ''}${i && !x.anyOrder ? ' after the earlier expected call' : ''}`);
      if (!x.anyOrder) break;
    }
    last = Math.max(last, k);
    i = k + 1;
  }
  for (const name of x.never ?? []) if (turn.calls.some((c) => c.name === name && c.ok)) fails.push(`${name} ran`);
  const made = turn.calls.filter((c) => !c.inner).length; // a batch's steps (scoreSteps) are not calls made
  if (x.maxCalls !== undefined && made > x.maxCalls) fails.push(`${made} calls (at most ${x.maxCalls})`);
  const changed = turn.calls.some((c) => c.ok && c.risk && c.risk !== 'read');
  const called = turn.calls.some((c) => c.ok); // "I'll read it" followed by the read is narration, not a promise
  if (x.noClaimWithoutCall) {
    const head = turn.reply.split(/:[ \t]*\n/)[0]; // a rewrite or quote after "...:" is not a claim
    if (!changed && CLAIM.test(head)) fails.push('claims an action that no call made');
    else if (!called && PROMISE.test(head)) fails.push('promises an action without a call');
  }
  if (x.replyMatches && !new RegExp(x.replyMatches, 'i').test(turn.reply)) fails.push(`reply does not match /${x.replyMatches}/`);
  const doc = x.draft ? turn.docs?.[x.draft] : turn.doc;
  if (x.doc && !matches(x.doc, doc)) fails.push(`the draft ${x.draft ? `${x.draft.slice(0, 8)} ` : ''}ends as ${(doc ?? []).map((b) => `${b.type} "${b.text.slice(0, 24)}"`).join(', ') || 'unread'}`);
  let part = 0; // the credit of a partly met annotation check, when it is the only fail
  const marks = [x.mark && scoreMark(doc, fixture(x.mark.fixture), x.mark.object, x.mark.minIoU), x.same && scoreSame(doc, fixture, x.same),
    ...Object.entries({ shape: scoreShape, line: scoreLine, lines: scoreLines, note: scoreNote, colour: scoreColour, noteBg: scoreNoteBg })
      .map(([k, check]) => x[k] && check(doc, fixture(x[k].truth), x[k]))];
  for (const m of marks) {
    if (!m || m.credit === 1) continue;
    fails.push(m.note);
    part = m.credit;
  }
  const missing = x.summary && scoreSummary(doc, fixture(x.summary.fixture), x.summary.sentences, x.summary.names);
  if (missing) fails.push(missing);
  if (x.typed) {
    const want = flat((turn.typed ?? []).join(''));
    const last = flat((doc ?? []).filter((b) => b.text.trim()).at(-1)?.text);
    if (!last.endsWith(want)) fails.push(`the draft ${x.draft ? `${x.draft.slice(0, 8)} ` : ''}does not end with the typed text "${want}" (it ends "${last.slice(-40)}")`);
  }
  if (x.viewStays && turn.openBefore !== turn.openAfter) fails.push(`the open draft changed from ${String(turn.openBefore).slice(0, 8)} to ${String(turn.openAfter).slice(0, 8)}`);
  let boxes;
  if (x.boxes) {
    boxes = scoreBoxes(turn.reply, fixture(x.boxes.fixture), turn.sent ?? null, x.boxes.minIoU ?? 0.5);
    if (!boxes.pass) fails.push(boxes.note);
  }
  const credit = !fails.length ? 1 : fails.length === 1 ? part : 0;
  return { pass: !fails.length, fails, credit, last, ...(boxes && { boxes }) };
}

/** A stepped case: the share of `steps` met (each step's credit, 0 to 1) as a score from 0 to 100; it passes at `threshold`
 * (default 100) when the case-wide checks (calls, never, maxCalls, noClaimWithoutCall, ... beside steps) hold too. `ordered`: a
 * step with calls that are met only before the previous call step's calls scores half. A batch's steps count as calls of their
 * own, right after it (`inner`), so a batch that does several steps meets them all and `never` sees inside it. A step with
 * `expectedFail` (a note: it waits for a later wave) is reported, not counted in the score; met, its note says so. */
function scoreSteps({ steps, threshold = 100, ordered = false, ...rest }, turn, fixture) {
  turn = expandBatches(turn);
  const base = score(rest, turn, fixture);
  let at = 0; // the calls after the last step met in order
  const rows = steps.map((s) => {
    const r = score(s.check, turn, fixture);
    let { credit } = r;
    const notes = r.fails;
    if (ordered && credit && s.check.calls?.length) {
      const inOrder = score(s.check, { ...turn, calls: turn.calls.slice(at) }, fixture);
      if (inOrder.credit) at += inOrder.last + 1;
      else {
        credit /= 2;
        notes.push('out of order');
      }
    }
    if (s.expectedFail && credit === 1) notes.push('met although expected to fail');
    return { name: s.name, credit, note: notes.join('; '), ...(s.expectedFail && { expectedFail: s.expectedFail }) };
  });
  const counted = rows.filter((r) => !r.expectedFail);
  const pct = Math.round((100 * counted.reduce((n, r) => n + r.credit, 0)) / (counted.length || 1));
  const missed = counted.filter((r) => r.credit < 1).map((r) => `${r.name}${r.credit ? ` (${r.credit * 100}%)` : ''}`);
  const fails = [...base.fails, ...(pct < threshold ? [`score ${pct}% (passes at ${threshold}%), missed: ${missed.join(', ')}`] : [])];
  return { pass: !fails.length, fails, score: pct, steps: rows, ...(base.boxes && { boxes: base.boxes }) };
}

module.exports = { score, matches, parseBoxes, scoreBoxes, blocks, scoreMark, scoreSummary, scoreShape, scoreLine, scoreNote };

if (require.main === module) {
  const assert = require('assert');
  assert(matches({ path: [3], patch: { $has: ['route', 'points'] } }, { path: [3], id: 'a', patch: { points: [] } }));
  assert(!matches({ path: [3] }, { path: [3, 0] }));
  const straight = { calls: [{ name: 'board_items_update', args: { id: 'y' }, result: { item: { route: 'straight', points: [] } } }] };
  assert(score(straight, { calls: [{ name: 'board_items_update', args: { id: 'y', patch: {} }, ok: true, result: { item: { route: 'straight', points: [] } } }], reply: '' }).pass);
  assert(!score(straight, { calls: [{ name: 'board_items_update', args: { id: 'y', patch: {} }, ok: true, result: { item: { route: 'straight', points: [{ x: 1, y: 2 }] } } }], reply: '' }).pass);
  assert(matches({ x: { $lt: 230 } }, { x: 40, y: 2 }) && !matches({ x: { $lt: 230 } }, { y: 2 }));
  const place = { calls: [{ name: { $any: ['board_items_place', 'board_items_update'] }, args: { id: 'v' }, result: { item: { x: { $lt: 71 } } } }] };
  assert(score(place, { calls: [{ name: 'board_items_place', args: { id: 'v', relation: 'left' }, ok: true, result: { item: { x: 46 } } }], reply: '' }).pass);
  assert(!score(place, { calls: [{ name: 'board_items_place', args: { id: 'v' }, ok: true, result: { item: { x: 200 } } }], reply: '' }).pass);
  assert(matches({ $any: [{ at: [2], position: 'before' }, { at: [1], position: { $ne: 'before' } }] }, { at: [1] }));
  assert(matches({ content: { $regex: '"type":"heading"' } }, { content: { json: [{ type: 'heading' }] } }));
  const shapes = { size: [640, 400], shapes: [{ label: 'red circle', kind: 'circle', box: [60, 80, 220, 240] }, { label: 'blue square', kind: 'square', box: [270, 150, 410, 290] }] };
  const norm = scoreBoxes('```json\n[{"label":"red circle","bbox_2d":[94,200,344,600]},{"label":"blue square","bbox_2d":[422,375,641,725]}]\n```', shapes, [1280, 800], 0.5);
  assert(norm.pass && norm.convention === 'normalised 0-1000', JSON.stringify(norm));
  const px = scoreBoxes('Here: {"red circle": [120, 160, 440, 480], "blue square": {"x1": 540, "y1": 300, "x2": 820, "y2": 580}}', shapes, [1280, 800], 0.5);
  assert(px.pass && px.convention.startsWith('pixels of the sent picture'), JSON.stringify(px));
  const t = (reply, calls = []) => score({ noClaimWithoutCall: true }, { calls, reply }, () => null);
  assert(!t("I've done it.").pass && !t("I've straightened it.").pass && !t("I'll straighten it now.").pass && t('Let me know if you want more.').pass);
  assert(t('Done.', [{ name: 'doc_insert', ok: true, risk: 'write' }]).pass && !t('Done.', [{ name: 'doc_get', ok: true, risk: 'read' }]).pass);
  // anyOrder: a rename and a move in either order, or in one call; without it the order counts.
  const two = { anyOrder: true, calls: [{ name: 'board_items_update', args: { patch: { html: 'Pump 2' } } }, { name: { $any: ['board_items_place', 'board_items_update'] }, result: { item: { x: { $lt: 200 } } } }] };
  const ren = { name: 'board_items_update', args: { patch: { html: 'Pump 2' } }, ok: true, result: { item: { x: 230 } } };
  const mov = { name: 'board_items_place', args: {}, ok: true, result: { item: { x: 40 } } };
  assert(score(two, { calls: [mov, ren], reply: '' }).pass && !score({ ...two, anyOrder: false }, { calls: [mov, ren], reply: '' }).pass);
  assert(score(two, { calls: [{ ...ren, args: { patch: { html: 'Pump 2', x: 40 } }, result: { item: { x: 40 } } }], reply: '' }).pass);
  assert.deepStrictEqual(score(two, { calls: [mov], reply: '' }).fails, ['no successful board_items_update matching {"patch":{"html":"Pump 2"}}']);
  // doc: the draft's blocks after the turn, all of them (an array pattern needs the same length).
  const kept = { doc: [{ type: 'heading' }, { text: { $regex: '^Five' } }] };
  assert(score(kept, { calls: [], reply: '', doc: [{ type: 'heading', text: 'T' }, { type: 'paragraph', text: 'Five players' }] }).pass);
  assert(/the draft ends as heading "T", paragraph "Five players", paragraph "x"/.test(score(kept, { calls: [], reply: '', doc: [{ type: 'heading', text: 'T' }, { type: 'paragraph', text: 'Five players' }, { type: 'paragraph', text: 'x' }] }).fails[0]));
  assert(!score(kept, { calls: [], reply: '' }).pass);
  // prompts.json reply checks: sensible replies pass, wrong ones fail.
  const cases = Object.fromEntries(require('./prompts.json').map((c) => [c.id, c.expect]));
  const says = (id, reply) => score(cases[id], { calls: [], reply }, () => null).pass;
  for (const r of ['Pump.', 'Pump is the widest shape.', 'The widest is Pump (220 wide).', 'Of Gearbox, Valve and Pump, Pump is widest.']) assert(says('picture-widest', r), r);
  for (const r of ['Valve is the widest. Pump and Gearbox are smaller.', 'Gearbox is widest, wider than Pump.', 'In the pump room board, Valve is widest.']) assert(!says('picture-widest', r), r);
  assert(says('ambiguous-box', 'Which box do you mean?') && says('ambiguous-box', 'Please tell me which box you mean: Gearbox, Valve or Pump.'));
  assert(!says('ambiguous-box', "I've enlarged the box, which is Pump.") && !says('ambiguous-box', 'Pump is bigger now.'));
  // straighten-yes: board_items_straighten or an equivalent board_items_update, route straight, no points, the ends on the facing
  // sides (Decision's right, End's left); straight but still bottom to bottom, or a bend left, fails.
  const yesItem = (from, to, points = []) => ({ route: 'straight', points, from: { item: 'd4q8n1x', anchor: from }, to: { item: 'e9r3t6w', anchor: to } });
  const yes = (name, item) => score(cases['straighten-yes'], { calls: [{ name, args: { path: [2], id: 'y6b1v4z' }, ok: true, risk: 'write', result: { id: 'y6b1v4z', item } }], reply: 'Straight now.' }, () => null).pass;
  assert(yes('board_items_straighten', yesItem([1, 0.5], [0, 0.5])) && yes('board_items_update', yesItem([1, 0.5], [0, 0.5])) && yes('board_items_update', yesItem('e', 'w')));
  assert(!yes('board_items_update', yesItem([0.5, 1], [0.5, 1])) && !yes('board_items_straighten', yesItem([1, 0.5], [0, 0.5], [{ x: 1, y: 2 }])) && !yes('board_items_place', yesItem([1, 0.5], [0, 0.5])));
  assert(says('delete-missing', "I don't have a draft called Nothing Here.") && says('delete-missing', "I couldn't find a draft called Nothing Here."));
  // blocks(): empty paragraphs go; the bold a block starts with, a synced canvas's flow id and a board's items stay.
  const b = (t, bold) => ({ type: 'text', text: t, ...(bold && { marks: [{ type: 'bold' }] }) });
  assert.deepStrictEqual(blocks({ content: [{ type: 'heading', content: [b('Valve', true), b(' order')] }, { type: 'paragraph' }, { type: 'canvas', attrs: { flow: { id: 'f' }, items: [] } }, { type: 'paragraph', content: [b(' ')] }] }),
    [{ type: 'heading', text: 'Valve order', firstBold: 'Valve' }, { type: 'canvas', text: '', flow: 'f', items: [] }]);
  // Steps: the share met; ordered, a call step met only before the previous step's call scores half.
  const op = (id) => ({ name: 'drafts_open', args: { draftId: id }, ok: true });
  const journey = { ordered: true, steps: [{ name: 'a', check: { calls: [{ name: 'drafts_open', args: { draftId: 'A' } }] } }, { name: 'b', check: { calls: [{ name: 'drafts_open', args: { draftId: 'B' } }] } }, { name: 'four', check: { replyMatches: '\\b4\\b' } }] };
  const full = score(journey, { calls: [op('A'), op('B')], reply: '4 drafts' });
  assert(full.pass && full.score === 100, JSON.stringify(full));
  const swapped = score(journey, { calls: [op('B'), op('A')], reply: '5' });
  assert(!swapped.pass && swapped.score === 50 && swapped.steps[1].note === 'out of order', JSON.stringify(swapped)); // 1 + 0.5 + 0 of 3
  assert(score({ ...journey, ordered: false }, { calls: [op('B'), op('A')], reply: '4' }).score === 100);
  assert(score({ ...journey, threshold: 50 }, { calls: [op('B'), op('A')], reply: '5' }).pass);
  assert(!score({ ...journey, never: ['drafts_delete'] }, { calls: [op('A'), op('B'), { name: 'drafts_delete', ok: true }], reply: '4' }).pass);
  // Docs by draft id (a draft that is not open at the end).
  assert(score({ draft: 'W3', doc: { $some: { text: 'Review' } } }, { calls: [], reply: '', doc: [], docs: { W3: [{ type: 'heading', text: 'Review' }] } }).pass);
  // Marks: IoU 0.3 against the thing's box; the label joined by a connector bound to both, or a free end near the box.
  const scene = { objects: [{ label: 'house', names: ['house', 'home'], box: [100, 180, 380, 480] }, { label: 'sun', names: ['sun'], box: [780, 50, 900, 170] }] };
  const wb = (items) => [{ type: 'heading', text: 'T' }, { type: 'whiteboard', text: '', items }];
  const mark = { id: 'm', type: 'shape', x: 90, y: 170, w: 300, h: 320 };
  const label = { id: 't', type: 'text', html: '<p>House</p>', x: 20, y: 40, w: 120, h: 30 };
  const credit = (items, object = 'house') => scoreMark(wb(items), scene, object).credit;
  assert.strictEqual(credit([mark, label, { type: 'connector', from: { item: 't' }, to: { item: 'm' } }]), 1);
  assert.strictEqual(credit([mark, label, { type: 'connector', from: { x: 80, y: 75 }, to: { x: 200, y: 165 } }]), 1); // free ends near both boxes
  assert.strictEqual(credit([mark, label]), 0.5);
  assert.strictEqual(credit([mark, { ...label, html: 'Tree' }, { type: 'connector', from: { item: 't' }, to: { item: 'm' } }]), 0.5);
  assert.strictEqual(credit([{ ...mark, x: 300, w: 600 }, label]), 0); // IoU about 0.1
  assert.strictEqual(credit([mark, label], 'sun'), 0);
  assert.strictEqual(credit([mark, label, { type: 'connector', from: { item: 'm' }, to: { item: 't' } }]), 1); // either direction
  assert.strictEqual(credit([mark, label, { id: 'i', type: 'image', x: 0, y: 0, w: 960, h: 600 }, { type: 'connector', from: { item: 't' }, to: { item: 'i' } }]), 0.5); // to another item
  const real = require('./fixture/scene.json'); // a shape over the whole picture marks none of its things (IoU, not containment)
  for (const o of real.objects) assert.strictEqual(scoreMark(wb([{ id: 'w', type: 'shape', x: 0, y: 0, w: 960, h: 600 }]), real, o.label).credit, 0, o.label);
  const markStep = { steps: [{ name: 'house', check: { mark: { fixture: 's', object: 'house' } } }, { name: 'sun', check: { mark: { fixture: 's', object: 'sun' } } }] };
  const ms = score(markStep, { calls: [], reply: '', doc: wb([mark]) }, () => scene);
  assert(ms.score === 25 && /house marked, not labelled/.test(ms.steps[0].note) && /sun not marked/.test(ms.steps[1].note), JSON.stringify(ms));
  // The summary: a paragraph after the whiteboard, two sentences, naming need of the things.
  const sum = (text, need = 2) => scoreSummary([...wb([]), { type: 'paragraph', text }], scene, 2, need);
  assert(sum('A house stands on the left. The sun shines above it.') === null);
  assert(/1 sentences naming 2/.test(sum('A house under the sun.')) && /naming 1/.test(sum('A house. A garden.')));
  assert(scoreSummary([{ type: 'paragraph', text: 'A house. The sun.' }, ...wb([])], scene, 2, 2) !== null); // above the whiteboard
  // prompts.json step checks on drafts as a turn could leave them.
  const W4 = ['Five players tested', 'Most players found', 'Two players missed', 'The flood gate opened'].map((t) => ({ type: 'paragraph', text: `${t} x.` }));
  const title = { type: 'heading', text: 'Week 4 - Playtest notes' };
  const stepped = (id, doc) => score(cases[id], { calls: [], reply: '', doc }, () => null).score;
  assert.strictEqual(stepped('long-reorder', [title, { type: 'paragraph', text: 'Next week a hint light goes above the first valve to cut the guessing.' }, ...W4]), 100);
  assert.strictEqual(stepped('long-reorder', [title, { type: 'paragraph', text: 'Next week a hint light goes above the first valve. It should cut the guessing.' }, ...W4]), 50);
  assert.strictEqual(stepped('long-reorder', [title, ...W4, { type: 'paragraph', text: 'Next week a hint light goes above the first valve to cut the guessing.' }]), 50);
  assert.strictEqual(stepped('long-reorder', [title, ...W4, { type: 'paragraph', text: 'Next week a hint light goes above the first valve. It should cut the guessing.' }]), 0);
  const pairs = (bold) => [title, ...['Five players', 'Most players', 'Two players', 'The flood gate', 'Next week'].flatMap((t, k) => [{ type: 'heading', text: `Head ${k} note`, ...(bold && { firstBold: bold }) }, { type: 'paragraph', text: `${t} x.` }])];
  assert.strictEqual(stepped('long-headings-bold', pairs('Head')), 100);
  assert.strictEqual(stepped('long-headings-bold', pairs('Head 0 note')), 50); // the whole heading bold, not its first word
  assert.strictEqual(stepped('long-headings-bold', pairs(null)), 50);
  assert.strictEqual(stepped('long-headings-bold', pairs(null).slice(0, 9)), 0);
  // journey-three-places: batches meet every step inside them, in order; a failed batch meets none; the Review heading on the
  // wrong draft, or not last, misses its step; never sees inside a batch, maxCalls counts the batch once.
  const [W1, W3] = ['8d1e4b7a-2c3f-4a5b-8e9d-0f1a2b3c4d5e', 'c5a7e9f1-3b2d-4c6e-a8f0-9e8d7c6b5a43'];
  const pump = (html) => [{ type: 'whiteboard', text: '', items: [{ id: 'm2p7w4k', type: 'shape', html }] }];
  const w3 = (...extra) => [{ type: 'heading', text: 'Week 3 - Lighting pass' }, { type: 'paragraph', text: 'The lighting pass starts next week.' }, ...extra];
  const review = { type: 'heading', text: 'Review' };
  const bt = (steps, ok = true) => ({ name: 'batch', ok, risk: 'write', args: { steps: steps.map(([id, args]) => ({ id, args })) } });
  const rn = ['board.items.update', { path: [2], id: 'm2p7w4k', patch: { html: 'Pump 2' } }];
  const ins = ['doc_insert', { at: [1], position: 'after', content: { markdown: '## Review' } }];
  const go = (calls, docs = { [W1]: pump('Pump 2'), [W3]: w3(review) }, reply = 'This thread has 4 drafts.') => score(cases['journey-three-places'], { calls, reply, docs }, () => null);
  const batched = go([bt([['drafts_open', { draftId: W1 }], rn]), bt([['drafts.open', { draftId: W3 }], ins])]);
  assert(batched.pass && batched.score === 100, JSON.stringify(batched));
  assert.strictEqual(go([bt([['drafts_open', { draftId: W1 }], rn], false), bt([['drafts_open', { draftId: W3 }], ins])]).score, 60);
  assert.strictEqual(go([bt([['drafts_open', { draftId: W3 }], ins]), bt([['drafts_open', { draftId: W1 }], rn])]).score, 80); // W3 first: two steps half
  assert.strictEqual(go([bt([['drafts_open', { draftId: W1 }], rn, ins]), bt([['drafts_open', { draftId: W3 }]])], { [W1]: pump('Pump 2'), [W3]: w3() }).score, 80); // Review on Week 1
  assert.strictEqual(go([bt([['drafts_open', { draftId: W1 }], rn]), bt([['drafts_open', { draftId: W3 }], ins])], { [W1]: pump('Pump 2'), [W3]: [w3()[0], review, w3()[1]] }).score, 80); // not last
  assert(!go([bt([['drafts_open', { draftId: W1 }], rn, ['doc_delete', { paths: [[1]] }]]), bt([['drafts_open', { draftId: W3 }], ins])]).pass);
  assert(go([bt(Array(9).fill(['drafts_open', { draftId: W1 }])), bt([rn]), bt([['drafts_open', { draftId: W3 }], ins])]).pass); // 3 calls made, 13 steps
  // Eval set 4: the user's annotations drawn again on a copy of their board (truth files); new notes; the typed words; the view.
  const truth = { kept: ['img', 'title'], after: ['Old notes on lanes, symmetry and flow.'], notes: { lane: 'n1', symmetr: 'n2', flow: 'n3' }, removed: [
    { id: 'r', type: 'shape', shape: 'rect', x: 314, y: 211, w: 362, h: 316 }, { id: 'h', type: 'shape', shape: 'line', x: 287, y: 283, w: 418, h: 90, flipY: true },
    { id: 'v', type: 'shape', shape: 'line', x: 451, y: 134, w: 47, h: 419 }, { id: 'e', type: 'shape', shape: 'ellipse', x: 518, y: 93, w: 146, h: 120 }],
  ellipses: { e: { names: ['corridor', 'encounter'], alsoBox: [900, 600, 1000, 700] } } };
  const on = (items, ...after) => [{ type: 'heading', text: 'T' }, { type: 'whiteboard', text: '', items: [{ id: 'img', type: 'image', x: 0, y: 0, w: 1400, h: 700 },
    { id: 'title', type: 'text', html: 'Corridor encounter', x: 520, y: 220, w: 200 }, ...items] }, ...after];
  const L = (o) => ({ id: 'n', type: 'shape', shape: 'line', ...o });
  const line = (items, id = 'h') => scoreLine(on(items), truth, { id, dist: 60, angle: 30 });
  assert.strictEqual(line([L({ x: 295, y: 290, w: 400, h: 80, flipY: true })]).credit, 1);
  assert(/none within 30 degrees/.test(line([L({ x: 475, y: 130, w: 40, h: 400 })]).note)); // at its centre, but upright
  assert(/nothing added within 60 px/.test(line([L({ x: 295, y: 400, w: 400, h: 80 })]).note)); // 112 px low
  assert.strictEqual(line([{ id: 'b', type: 'shape', shape: 'rect', x: 314, y: 211, w: 362, h: 316 }]).credit, 0); // the mid box is no lane
  assert.strictEqual(line([{ id: 'b', type: 'shape', shape: 'rect', x: 296, y: 310, w: 400, h: 40 }]).credit, 1); // a thin box is one
  assert.strictEqual(line([{ id: 'c', type: 'connector', from: { x: 290, y: 370 }, to: { x: 700, y: 290 } }]).credit, 1);
  assert.strictEqual(line([L({ x: 495, y: 128, w: 0, h: 400, rot: 90 })]).credit, 1); // upright, turned flat
  assert.strictEqual(line([L({ x: 455, y: 140, w: 40, h: 410 })], 'v').credit, 1);
  assert.strictEqual(scoreLine(on([L({ x: 295, y: 290, w: 400, h: 80 })]), { ...truth, kept: [...truth.kept, 'n'] }, { id: 'h' }).credit, 0); // kept, not added
  const E = (o) => ({ id: 'm', type: 'shape', shape: 'ellipse', x: 512, y: 90, w: 150, h: 125, ...o });
  const T = (o) => ({ id: 't', type: 'text', html: 'Corridor encounter', x: 520, y: 260, w: 160, ...o });
  const zone = (items) => scoreShape(on(items), truth, { id: 'e', kinds: ['ellipse', 'round'], minIoU: 0.25, within: 200 }).credit;
  assert.strictEqual(zone([E(), T()]), 1);
  assert.strictEqual(zone([E()]), 0.5); // the label next to it is the user's own, not added
  assert.strictEqual(zone([E(), T({ y: 500 })]), 0.5); // 285 px below
  assert.strictEqual(zone([E({ html: 'Encounter' })]), 1); // the mark's own text
  assert.strictEqual(zone([E({ shape: 'rect' }), T()]), 0);
  assert.strictEqual(zone([E({ x: 910, y: 610, w: 80, h: 80 }), T({ x: 900, y: 700 })]), 1); // on the alsoBox
  assert.strictEqual(scoreShape(on([{ id: 'b', type: 'shape', shape: 'round', x: 320, y: 215, w: 350, h: 300 }]), truth, { id: 'r', kinds: ['rect', 'round'] }).credit, 1);
  const nt = (items, ...after) => ['lane', 'symmetr', 'flow'].map((word) => scoreNote(on(items, ...after), truth, { word }).credit).join('');
  const N = (html, k = 1) => ({ id: `n${k}`, type: 'text', html, x: 20, y: 100 * k, w: 200 });
  assert.strictEqual(nt([N('Three lanes each.'), N('Not symmetrical.', 2), N('It flows through mid.', 3)]), '111');
  assert.strictEqual(nt([N('Three lanes, not symmetrical, good flow.')]), '100'); // one note counts once
  assert.strictEqual(nt([N('Both maps are asymmetrical.', 2)]), '010');
  assert.strictEqual(nt([N('The lanes are symmetrical.'), N('Three lanes.', 2)]), '110'); // the most words, each note once
  assert.strictEqual(nt([], { type: 'paragraph', text: 'Old notes on lanes, symmetry and flow.' }), '000'); // there before the turn
  assert.strictEqual(nt([N('Lanes.')], { type: 'bulletList', text: '', lines: ['Symmetric halves.', 'Flow by the sides.'] }), '111');
  const typedOk = (text) => score({ draft: 'C', typed: true }, { calls: [], reply: '', docs: { C: [{ type: 'paragraph', text }] }, typed: [' Typing continues here.', ' The', ' second'] }).pass;
  assert(typedOk('Styling is clean. Typing continues here. The second') && !typedOk('Styling is clean. Typing continues here. second'));
  const view = (openAfter) => score({ viewStays: true }, { calls: [], reply: '', openBefore: 'C', openAfter });
  assert(view('C').pass && /changed from C to S/.test(view('S').fails[0]));
  const xf = { steps: [{ name: 'a', check: { replyMatches: 'ok' } }, { name: 'stays', check: { viewStays: true }, expectedFail: 'later' }] };
  const moved = score(xf, { calls: [], reply: 'ok', openBefore: 'C', openAfter: 'S' });
  assert(moved.pass && moved.score === 100 && moved.steps[1].expectedFail === 'later' && /changed/.test(moved.steps[1].note), JSON.stringify(moved));
  assert(/met although expected to fail/.test(score(xf, { calls: [], reply: 'ok', openBefore: 'C', openAfter: 'C' }).steps[1].note));
  // prompts.json eval set 4 cases on the boards their stub scripts leave (the real run: DAF_EVAL_STUB=1 npm run assistant:eval).
  const fx = (name) => require(`./fixture/${name}`);
  const byId = Object.fromEntries(require('./prompts.json').map((c) => [c.id, c]));
  const board = (file, script) => [{ type: 'whiteboard', text: '', items: [...fx(file).kept.map((id) => ({ id, type: 'image' })),
    ...script.flatMap((e) => e.tool_calls ?? []).filter((c) => c.name === 'board_items_add').flatMap((c) => c.arguments.items)] }];
  const left = (id, file, script) => score(byId[id].expect, { calls: [], reply: '', doc: board(file, script) }, fx);
  const [lanesCase, zonesCase, del] = ['annotate-valorant-lanes', 'annotate-rivals-zones', 'delegate-annotation'].map((id) => byId[id]);
  assert.strictEqual(left(lanesCase.id, 'structure-truth.json', lanesCase.stub).score, 100);
  assert.strictEqual(left(lanesCase.id, 'structure-truth.json', lanesCase.stubWrong).score, 56);
  const frames = [{ tool_calls: [{ name: 'board_items_add', arguments: { items: [[142, 49, 642], [741, 49, 661]].map(([x, y, w], k) => ({ id: `f${k}`, type: 'shape', shape: 'rect', x, y, w, h: w })) } }] }];
  const framed = board('structure-truth.json', frames);
  for (const c of [lanesCase, del]) { // a box around each map is no mid box
    const got = score(c.expect, { calls: [], reply: '', doc: framed, docs: { [del.expect.steps[0].check.draft]: framed } }, fx).steps;
    assert.deepStrictEqual(got.slice(0, 2).map((s) => [s.name, s.credit]), [['Ascent mid boxed', 0], ['Lotus mid boxed', 0]], c.id);
  }
  assert.strictEqual(left(zonesCase.id, 'iteration-truth.json', zonesCase.stub).score, 100);
  assert.strictEqual(left(zonesCase.id, 'iteration-truth.json', zonesCase.stubWrong).score, 50);
  const [S4, typed] = [del.expect.steps[0].check.draft, del.typeWhileRunning.slice(0, 3)];
  const handed = score(del.expect, { calls: [], reply: '', docs: { [S4]: board('structure-truth.json', del.stub), [del.draft]: [{ type: 'paragraph', text: `Styling is clean.${typed.join('')}` }] },
    typed, openBefore: del.draft, openAfter: S4 }, fx);
  assert(handed.pass && handed.score === 100 && handed.steps.at(-1).expectedFail, JSON.stringify(handed));
  console.log('score.js self-check passed');
}
