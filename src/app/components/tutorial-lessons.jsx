import { useState } from 'react';
import { TextSelection } from '@tiptap/pm/state';
import { Check, Compass, Copy, FilePlus, Frame, Hand, Keyboard, MessageSquare, Mic, Mouse, Search } from 'lucide-react';
import { TITLEBAR } from '@/components/ui/bounds';
import { Button } from '@/components/ui/button';
import { canvasEditor } from '../../canvas.js';
import { addImageFilesToEditor } from '../../whiteboard.js';
import { closeQuickTools, closeToolSearch, insertCanvas, saveSettings, toggleToolSearch } from '../actions.js';
import { chordOf } from '../keys.mjs';
import { keyIs, keyLabel } from '../keybinds.js';
import { motion } from '../motion.js';
import { getState, setState } from '../store.js';
import { tap } from './Tutorial.jsx';

// The tutorial's lessons (SPEC §7l Tutorial; Tutorial.jsx plays them): their steps, and what each step does in the app. Lesson
// 1 makes a draft; lesson 2 writes lorem ipsum into it and teaches the quick access menu (Ctrl+Tab, keys.mjs app.quickTools);
// lesson 3 puts canvases in it: one to open and clear away, then a pasted picture of a dog to annotate; lesson 4 teaches tool
// search (Ctrl+Space) on a line of its own; lesson 5 shows where things are, then the draft goes and the card says goodbye.

export const LESSONS = [{ name: 'Your first draft', Icon: FilePlus }, { name: 'The quick access menu', Icon: Keyboard }, { name: 'Canvas', Icon: Frame },
  { name: 'Tool search', Icon: Search }, { name: 'A look around', Icon: Compass }];

// ---------------------------------------------------------------------------------------------
// Lesson 2: lorem ipsum, three of its lines selected and made a list

const LOREM = [
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
  'Ut enim ad minim veniam',
  'Quis nostrud exercitation ullamco',
  'Duis aute irure dolor in reprehenderit',
  'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
];
const LINES = LOREM.slice(1, 4);

/** The paragraphs holding LINES in the open draft, in order ([{node, pos}], in a list too), or null until all are there. */
function loremLines() {
  const found = [];
  getState().editor?.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return found.length < LINES.length;
    if (node.textContent === LINES[found.length]) found.push({ node, pos });
    return false;
  });
  return found.length === LINES.length ? found : null;
}

/** Lesson 2's text: the lorem ipsum, in place of the draft's empty paragraph (after its text when it has some). */
function writeLorem() {
  const ed = getState().editor;
  if (!ed || loremLines()) return;
  const { doc } = ed.state;
  const blank = doc.childCount === 1 && !doc.firstChild.content.size;
  ed.chain().insertContentAt(blank ? { from: 0, to: doc.content.size } : doc.content.size,
    LOREM.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))).run();
}

const lineDoms = () => {
  const lines = loremLines();
  const view = getState().editor?.view;
  return lines && view ? lines.map(({ pos }) => view.nodeDOM(pos)) : null;
};
const listDoms = () => { const d = lineDoms(); return d && [...new Set(d.map((p) => p.closest('ul, ol') ?? p))]; };

/** The text of LINES as a doc range [from, to]: as far as the select step's drag can select. */
function linesText() {
  const lines = loremLines();
  const last = lines?.at(-1);
  return lines && [lines[0].pos + 1, last.pos + last.node.nodeSize - 1];
}

/** The selection reaches from the first of LINES into the last. */
function selectsLines() {
  const lines = loremLines();
  const sel = getState().editor?.state.selection;
  if (!lines || !sel || sel.empty) return false;
  const [first, last] = [lines[0], lines.at(-1)];
  return sel.from < first.pos + first.node.nodeSize - 1 && sel.to > last.pos + 1;
}

/** The drag the pointer shows: from the start of the first of LINES to the end of the last ({x, y, drag: [dx, dy]}). */
function dragOver() {
  const span = linesText();
  const view = getState().editor?.view;
  if (!span || !view) return null;
  const [a, b] = span.map((p) => view.coordsAtPos(p));
  const mid = (r) => (r.top + r.bottom) / 2;
  return { x: a.left, y: mid(a), drag: [b.left - a.left, mid(b) - mid(a)] };
}

/** Under the text cursor (the selection's head). */
const caretPoint = () => {
  const { view } = getState().editor;
  const c = view.coordsAtPos(view.state.selection.head);
  return { x: c.left, y: c.bottom };
};
const dragEnd = () => getState().tutorial?.at ?? caretPoint(); // where the user's drag over the lines ended
/** The quick access menu at `at`, for `board` (null: the text). */
const openMenu = (at, board = null) => at && setState({ quickTools: { board, x: at.x, y: at.y } });
const holdMenu = (at, board) => () => getState().quickTools || openMenu(at(), board?.()); // held open through a lesson's menu steps
// Where the menu will open, kept clear of the card while the user is still to open it: QuickTools.jsx centres its 20rem island
// under the point.
const menuSpace = () => { const at = getState().tutorial?.at; return at ? [{ x: at.x - 170, y: at.y - 8, w: 340, h: 260 }] : []; };

// ---------------------------------------------------------------------------------------------
// Lesson 3: canvases in the draft

/** The text cursor on a new line at the end of the draft, where a canvas or picture goes (the user: not in the text). */
function caretToEnd() {
  getState().editor?.chain().focus().command(({ tr }) => {
    const last = tr.doc.lastChild;
    if (last.type.name !== 'paragraph' || last.content.size) tr.insert(tr.doc.content.size, tr.doc.type.schema.nodes.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1));
    return true;
  }).scrollIntoView().run();
}
const pageOf = () => document.querySelector('#page-wrap .page'); // the draft's page, the light's outline round a canvas
const lastCanvas = () => [...(getState().editor?.view.dom.querySelectorAll('.sc') ?? [])].at(-1) ?? null; // the canvas the lesson put in
const endLine = () => getState().editor?.view.dom.lastElementChild ?? null; // the draft's last line, where the picture is pasted

/** The canvas the lesson opened goes, with one empty line left at the end and the text cursor on it (the canvas had an empty
 * line before it and one after). */
function clearCanvas() {
  lastCanvas()?.scView?.remove();
  getState().editor?.chain().focus().command(({ tr }) => {
    const n = tr.doc.childCount;
    const blank = (k) => tr.doc.child(k).type.name === 'paragraph' && !tr.doc.child(k).content.size;
    if (n > 1 && blank(n - 1) && blank(n - 2)) tr.delete(tr.doc.content.size - tr.doc.lastChild.nodeSize, tr.doc.content.size);
    tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1));
    return true;
  }).run();
}

// The picture: Lucide's dog on white, its right half left empty for the box drawn beside the dog (the user, 2026-10-27).
const PIC = { w: 800, h: 400 };
const DOG = [ // lucide-react 1.52 dog (ISC), drawn at 11 times its 24 px
  'M11.25 16.25h1.5L12 17z', 'M16 14v.5', 'M8 14v.5',
  'M4.42 11.247A13.152 13.152 0 0 0 4 14.556C4 18.728 7.582 21 12 21s8-2.272 8-6.444a11.702 11.702 0 0 0-.493-3.309',
  'M8.5 8.5c-.384 1.05-1.083 2.028-2.344 2.5-1.931.722-3.576-.297-3.656-1-.113-.994 1.177-6.53 4-7 1.923-.321 3.651.845 3.651 2.235A7.497 7.497 0 0 1 14 5.277c0-1.39 1.844-2.598 3.767-2.277 2.823.47 4.113 6.006 4 7-.08.703-1.725 1.722-3.656 1-1.261-.472-1.855-1.45-2.239-2.5',
];
const DOG_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${PIC.w}" height="${PIC.h}" viewBox="0 0 ${PIC.w} ${PIC.h}">`
  + `<rect width="${PIC.w}" height="${PIC.h}" fill="#fff"/><g transform="translate(70 70) scale(11)" fill="none" stroke="#1f1f1f" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">`
  + `${DOG.map((d) => `<path d="${d}"/>`).join('')}</g></svg>`)}`;
let dogPng = null;
/** The picture as a PNG blob (made once). */
function dogBlob() {
  dogPng ??= new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = Object.assign(document.createElement('canvas'), { width: PIC.w, height: PIC.h });
      c.getContext('2d').drawImage(img, 0, 0);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be drawn'))), 'image/png');
    };
    img.onerror = reject;
    img.src = DOG_URL;
  });
  return dogPng;
}

/** Ctrl+V on the paste step: the tutorial's picture goes in at the text cursor as any pasted picture does (a canvas), whatever
 * the clipboard holds (the user: nothing on it can upset the lesson). */
async function pasteDog() {
  const ed = getState().editor;
  if (ed) await addImageFilesToEditor(ed, [new File([await dogBlob()], 'dog.png', { type: 'image/png' })], { canvas: true }); // a Document's too
}

/** A copy of `el`'s picture flying from it to `to` (a rect), shrinking and fading: what Copy picture sends to the paste line. */
function fly(el, to) {
  const a = el?.getBoundingClientRect();
  if (!a || !to) return;
  const ghost = Object.assign(el.cloneNode(), { ariaHidden: true });
  Object.assign(ghost.style, { position: 'fixed', left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, zIndex: 62, pointerEvents: 'none',
    transformOrigin: 'top left', borderRadius: '6px', boxShadow: '0 8px 24px rgb(0 0 0 / 0.35)' });
  document.body.append(ghost);
  ghost.animate([{ translate: '0 0', scale: 1, opacity: 1 }, { translate: `${to.left - a.left}px ${to.top - a.top}px`, scale: 0.3, opacity: 0.15 }],
    { duration: 850, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', fill: 'forwards' }).finished.then(() => ghost.remove(), () => ghost.remove());
}

/** The copy step's panel: the picture, and Copy picture, which copies it (a PNG on the clipboard), springs and sends a small
 * copy of it flying to the line it is pasted on; then `go`, the paste step. */
export function DogPanel({ go }) {
  const [copied, setCopied] = useState(false);
  const copy = (e) => {
    if (copied) return;
    setCopied(true);
    try {
      navigator.clipboard.write([new ClipboardItem({ 'image/png': dogBlob() })]).catch(() => {}); // the paste uses the tutorial's own
    } catch {}
    fly(e.currentTarget.closest('[data-tutorial-dog]').querySelector('img'), endLine()?.getBoundingClientRect());
    setTimeout(go, 950);
  };
  return (
    <div data-tutorial-dog className="grid gap-2">
      <img src={DOG_URL} alt="A dog" draggable={false} className="w-full rounded-md border" />
      <Button size="sm" data-copied={copied || undefined} onClick={copy}>{copied ? <><Check />Copied</> : <><Copy />Copy picture</>}</Button>
    </div>
  );
}

// The board of the canvas being edited, its items and where they show. Picture px (PIC) map onto the picture item's box.
const ids = {}; // the items lesson 3 works with: dog (the picture), heart, box, arrow; cleared for each run (lessons())
const boardOf = () => canvasEditor.get()?.board ?? null;
const boardDom = () => boardOf()?.dom ?? null;
const itemOf = (id) => (id && boardOf()?.items.find((i) => i.id === id)) || null;
const elOf = (id) => (id && boardOf()?.itemEl(id)) || null;
const boxEl = () => elOf(ids.box);
const dogEl = () => elOf(ids.dog);
const heartEl = () => elOf(ids.heart);
const boxOf = (i) => i && { x: i.x, y: i.y, w: i.w, h: i.h };
const same = (a, b, tol) => !!a && !!b && ['x', 'y', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) <= tol);
function onBoard(p) {
  const i = itemOf(ids.dog);
  if (!i) return null;
  const [kx, ky] = [i.w / PIC.w, i.h / PIC.h];
  return { x: i.x + p.x * kx, y: i.y + p.y * ky, ...(p.w != null && { w: p.w * kx, h: p.h * ky }) };
}
/** Board px to the window's: a canvas being edited is drawn scaled in the page. */
function onScreen(p) {
  const b = boardOf();
  if (!b || !p) return null;
  const r = b.dom.getBoundingClientRect();
  const s = b.scale();
  return { x: r.left + p.x * s, y: r.top + p.y * s, ...(p.w != null && { w: p.w * s, h: p.h * s }) };
}
const shown = (p) => onScreen(onBoard(p)); // picture px to the window's
const middleOf = (el) => { const r = el?.getBoundingClientRect(); return r?.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; };
/** The handle `corner` of rect `r` (n, ne, e, …): where it sits on the outline. */
const handleOf = (r, corner) => ({
  x: corner.includes('w') ? r.x : corner.includes('e') ? r.x + r.w : r.x + r.w / 2,
  y: corner.includes('n') ? r.y : corner.includes('s') ? r.y + r.h : r.y + r.h / 2,
});
const part = (cls) => () => boxEl()?.querySelector(`:scope > .${cls}`) ?? null; // a handle or dot of the selected box

/** The picture canvas is open: its picture is the dog. */
function openedPicture() {
  const dog = boardOf()?.items.find((i) => i.type === 'image');
  if (dog) ids.dog = dog.id;
  return !!dog;
}
const selectBox = () => ids.box && boardOf()?.select([ids.box]);
const showLayers = () => getState().settings?.layersPanel === false && saveSettings({ layersPanel: true });
const menuBelowDog = () => shown({ x: 200, y: 340 });

// A glyph `text` flying from `a` to `b` (window points) in an arc, then gone: the heart the card drops, the dog's barks.
function toss(text, a, b, { size = 40, ms = 700 } = {}) {
  if (!a || !b) return;
  const el = Object.assign(document.createElement('span'), { textContent: text, ariaHidden: true });
  Object.assign(el.style, { position: 'fixed', left: `${a.x}px`, top: `${a.y}px`, fontSize: `${size}px`, lineHeight: 1, zIndex: 62, pointerEvents: 'none',
    translate: '-50% -50%', fontWeight: 600 });
  document.body.append(el);
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  el.animate([{ transform: 'translate(0, 0) scale(0.6)', opacity: 0 }, { transform: `translate(${dx / 2}px, ${dy / 2 - 60}px) scale(1.1)`, opacity: 1, offset: 0.5 },
    { transform: `translate(${dx}px, ${dy}px) scale(1)`, opacity: 1 }], { duration: ms, easing: 'ease-in-out', fill: 'forwards' })
    .finished.then(() => el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, fill: 'forwards' }).finished).finally(() => el.remove());
}

/** The card "accidentally" drops a heart on the picture: it flies from the card and lands as a text item on top. */
function dropHeart() {
  const b = boardOf();
  const spot = onBoard({ x: 660, y: 270 });
  if (!b || !spot) return;
  toss('❤️', middleOf(document.querySelector('[data-tutorial-card]')), onScreen(spot), { size: 44 });
  setTimeout(() => {
    const heart = { ...b.textItem({ x: spot.x - 45, y: spot.y - 40 }), html: '❤️', size: 56, w: 90, align: 'center' };
    b.items.push(heart);
    ids.heart = heart.id;
    b.commit(true);
  }, 650);
}

/** An item's element plays CSS animation `name` (app.css) once. */
function play(el, name) {
  if (!el) return;
  el.classList.remove(name);
  void el.offsetWidth; // restart it
  el.classList.add(name);
  el.addEventListener('animationend', () => el.classList.remove(name), { once: true });
}
const face = () => shown({ x: 200, y: 150 });
/** "dog" typed: the dog barks, its picture shaking with two woofs. */
function bark() {
  play(dogEl(), 'tutorial-bark');
  const f = face();
  if (!f) return;
  toss('Woof!', f, { x: f.x - 70, y: f.y - 70 }, { size: 22, ms: 650 });
  setTimeout(() => toss('Woof!', f, { x: f.x + 60, y: f.y - 80 }, { size: 22, ms: 650 }), 500);
}
/** The box points at the dog: the dog jumps for joy and hearts rise round it. */
function happy() {
  play(dogEl(), 'tutorial-happy');
  const f = face();
  if (!f) return;
  [-70, -25, 25, 70].forEach((dx, k) => setTimeout(() => toss('❤️', f, { x: f.x + dx, y: f.y - 90 - (k % 2) * 25 }, { size: 22, ms: 700 }), k * 140));
}

// The box's places in picture px: drawn up and right of the dog, made wider, then taller, then back with its corner.
const BOX = { x: 430, y: 70, w: 180, h: 90 };
const WIDE = { ...BOX, w: 280 };
const TALL = { ...WIDE, y: 30, h: 130 };
const DOG_AT = { x: 320, y: 236 }; // just right of the dog's right cheek, where the box's arrow points

let seen = null; // the board's item ids when a drag was pressed
const fresh = (type) => boardOf()?.items.filter((i) => !seen?.has(i.id) && i.type === type) ?? [];
function drop(items) {
  const b = boardOf();
  if (!b || !items.length) return;
  b.items = b.items.filter((i) => !items.includes(i));
  b.select(null);
  b.commit();
}
const note = () => { seen = new Set(boardOf()?.items.map((i) => i.id)); };

// A drag step's drag (Tutorial.jsx): `from` and `to`, window points of hint 1 (press) and hint 2 (let go); `press`, the
// element that takes the press there (a handle); `ghost`, what the drag would do ({a, b}: a box from rect a to rect b; {turn}:
// the box swinging; {line}: an arrow along those points); `before`, at the press; `track`, every frame while held; `check(near)`,
// after the release (`near`: it landed on hint 2): true done, false wrong (then `undo`), null nothing to judge; `pin`, Shift on
// the release (a connector's tip pinned where it lands); `then`, run once it is done.
const drawBox = {
  from: () => shown({ x: BOX.x, y: BOX.y }),
  to: () => shown({ x: BOX.x + BOX.w, y: BOX.y + BOX.h }),
  press: boardDom,
  ghost: () => ({ a: shown({ x: BOX.x, y: BOX.y, w: 0, h: 0 }), b: shown(BOX) }),
  before: note,
  check: () => {
    const [made] = fresh('shape');
    if (!made) return null;
    const want = onBoard(BOX);
    if (!same(boxOf(made), want, 4)) return false;
    Object.assign(made, want);
    ids.box = made.id;
    boardOf().commit();
    return true;
  },
  undo: () => {
    drop(fresh('shape'));
    boardOf()?.setMode('shape'); // drawing a shape put the tool down: the box again, for the next try
  },
};

let start = null; // the box before a resize drag
const resize = (corner, to) => ({
  from: () => middleOf(part(`wb-h-${corner}`)()),
  to: () => shown(handleOf(to, corner)),
  press: part(`wb-h-${corner}`),
  ghost: () => ({ a: onScreen(boxOf(itemOf(ids.box))), b: shown(to) }),
  before: () => { start = boxOf(itemOf(ids.box)); },
  check: () => {
    const i = itemOf(ids.box);
    if (!i || same(boxOf(i), start, 0.5)) return null;
    const want = onBoard(to);
    if (!same(boxOf(i), want, 4)) return false;
    Object.assign(i, want);
    boardOf().commit();
    return true;
  },
  undo: () => {
    Object.assign(itemOf(ids.box) ?? {}, start);
    boardOf()?.commit();
  },
});

let swing = [0, 0]; // the least and most the box turned while the user rotated it, in degrees either side of upright
const wiggle = {
  from: () => middleOf(part('wb-rot-ne')()),
  press: part('wb-rot-ne'),
  ghost: () => ({ turn: onScreen(boxOf(itemOf(ids.box))) }),
  track: () => {
    const a = ((((itemOf(ids.box)?.rot ?? 0) % 360) + 540) % 360) - 180;
    swing = [Math.min(swing[0], a), Math.max(swing[1], a)];
  },
  check: () => {
    if (swing[0] > -10 || swing[1] < 10) return null;
    const i = itemOf(ids.box);
    if (i) i.rot = 0; // upright again for the next steps
    boardOf()?.commit();
    return true;
  },
};

// The box's arrow (the user's sketch, 2026-10-27): from its bottom dot, down, then left to the dog's right cheek.
const connect = {
  from: () => middleOf(part('wb-qc-s')()),
  to: () => shown(DOG_AT),
  press: part('wb-qc-s'),
  reach: 56, // the dog is a big target
  pin: true,
  ghost: () => { const [a, b] = [connect.from(), connect.to()]; return a && b ? { line: [a, { x: a.x, y: b.y }, b] } : {}; },
  before: note,
  check: (near) => {
    const [c] = fresh('connector');
    if (!c) return null;
    if (!near || c.from?.item !== ids.box || c.to?.item !== ids.dog) return false;
    c.to = { item: ids.dog, anchor: [DOG_AT.x / PIC.w, DOG_AT.y / PIC.h], pin: true }; // its tip right there, wherever it was let go
    ids.arrow = c.id;
    boardOf().commit();
    return true;
  },
  undo: () => {
    drop(fresh('connector'));
    selectBox(); // its dots show on the selected box only
  },
  then: happy,
};

const arrowEl = () => elOf(ids.arrow);
/** The middle of the arrow along its path, in the window: a double-click there writes its label. */
function arrowMid() {
  const pts = boardOf()?.geo.get(ids.arrow)?.pts;
  if (!pts?.length) return null;
  const lens = pts.slice(1).map((q, k) => Math.hypot(q.x - pts[k].x, q.y - pts[k].y));
  let half = lens.reduce((a, b) => a + b, 0) / 2;
  for (const [k, len] of lens.entries()) {
    if (half <= len) return onScreen({ x: pts[k].x + ((pts[k + 1].x - pts[k].x) * half) / (len || 1), y: pts[k].y + ((pts[k + 1].y - pts[k].y) * half) / (len || 1) });
    half -= len;
  }
  return onScreen(pts.at(-1));
}
/** The arrow's label while it is edited, else null. */
const arrowLabel = () => { const b = boardOf(); return ids.arrow && b?.editingId === ids.arrow ? b.editText() : null; };
/** A new label reads "Label", selected so that typing replaces it: emptied for the type step, which counts what is typed. */
function clearLabel() {
  const t = arrowLabel();
  if (!t) return;
  t.textContent = '';
  document.getSelection().selectAllChildren(t);
}

// ---------------------------------------------------------------------------------------------
// Lesson 4: tool search on a line of its own (the user, 2026-10-27)

const LAZY = "I'm lazy! Even quicker?";
/** The draft's line LAZY ({node, pos}), heading or not, or null. */
function lazyLine() {
  let found = null;
  getState().editor?.state.doc.forEach((node, pos) => { if (node.textContent === LAZY) found = { node, pos }; });
  return found;
}
const lazyDom = () => { const l = lazyLine(); return l ? getState().editor.view.nodeDOM(l.pos) : null; };
/** LAZY selected, written on a new last line the first time; canvas mode is left first (lesson 3 ends in it). */
function selectLazy() {
  canvasEditor.get()?.close(true);
  const ed = getState().editor;
  if (!ed) return;
  if (!lazyLine()) {
    caretToEnd();
    ed.chain().insertContent(LAZY).run();
  }
  const { node, pos } = lazyLine();
  ed.chain().focus().setTextSelection({ from: pos + 1, to: pos + node.nodeSize - 1 }).scrollIntoView().run();
}
const searching = (e) => keyIs('app.toolSearch', e);
const openSearch = () => getState().toolSearch || toggleToolSearch(); // Ctrl+Space, done by the keys step
const search = () => document.querySelector('[role="dialog"]:has([cmdk-root])'); // the open tool search
const searchInput = () => search()?.querySelector('[cmdk-input]') ?? null;
const firstTool = () => search()?.querySelector('[cmdk-item]') ?? null; // the best match while typing
/** Where the pointer shows a colour: the fourth swatch of the open options. */
const swatchAt = () => middleOf(document.querySelectorAll('[data-tool-options] button[style*="background"]')[3]);
const closeOptions = () => getState().toolOptions && setState({ toolOptions: null });
/** The text cursor at the end of the lazy line, nothing selected. */
function restCaret() {
  const l = lazyLine();
  if (l) getState().editor?.commands.setTextSelection(l.pos + l.node.nodeSize - 1);
}
/** The colour picked: the options close and the selection lets go, so the highlight shows (the user, 2026-10-27: the
 * tutorial only, the app keeps a selection). */
function showHighlight() {
  closeOptions();
  restCaret();
}

/** The second Ctrl+Space (the user, 2026-10-27): the left hand stays on the keys, the right hand on the mouse. */
function Hands() {
  return (
    <div data-tutorial-hands className="grid grid-cols-2 rounded-2xl border bg-background/40 px-3 pt-4 pb-2.5 text-center text-xs text-muted-foreground">
      <div className="grid justify-items-center gap-1.5">
        <span className="relative"><Keyboard className="size-9" /><Hand data-hand="left" className="absolute -top-3 left-2.5 size-5 -scale-x-100 text-foreground" /></span>
        Left hand on the keys
      </div>
      <div className="grid justify-items-center gap-1.5">
        <span className="relative"><Mouse className="size-9" /><Hand data-hand="right" className="absolute -top-3 left-2 size-5 text-foreground" /></span>
        Right hand on the mouse
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Lesson 5: a look around, then goodbye (the user, 2026-10-27)

const whole = () => ({ x: 0, y: TITLEBAR, w: innerWidth, h: innerHeight - TITLEBAR }); // the light on everything: no dim
const workspaces = () => [...document.querySelectorAll('nav[aria-label="Workspaces"] button')].slice(0, 2); // Plans, Flowcharts
/** Where a button of the right island shows once it is set up (Chat.jsx RightIsland keeps its place unseen): the chat button
 * in the bottom slot (`k` 0), the mic button above it (1); a regular icon button is 2rem. */
function slot(k) {
  const r = document.querySelector('[data-right-island]')?.getBoundingClientRect();
  const s = 2 * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 13);
  return r && { x: r.right - 5 - s, y: r.bottom - 5 - s - k * (s + 4), w: s, h: s };
}
const chatOn = () => document.querySelector('[data-chat-button]');
const micOn = () => document.querySelector('[data-dictation-button]');
const chatButton = () => chatOn() ?? slot(0); // a rect, where it is not there yet: the card draws its outline (`mark`)
const micButton = () => micOn() ?? slot(1);
/** The quick access menu at the lazy line, then in the dog's canvas, then gone with the canvas. */
const menuInText = () => { selectLazy(); openMenu(caretPoint()); };
function menuInCanvas() {
  closeQuickTools();
  if (!canvasEditor.get()) lastCanvas()?.scView?.open();
  openMenu(menuBelowDog(), boardOf());
}
const leaveCanvas = () => { closeQuickTools(); canvasEditor.get()?.close(true); restCaret(); }; // not the canvas left selected
// The text tools: a Document's tool menu on the left, shown tab by tab; a forum post's ribbon at the bottom, with More tools on.
const ribbon = () => document.querySelector('[data-ribbon]');
const showTab = (label) => () => tap([...(ribbon()?.querySelectorAll('[role="tab"]') ?? [])].find((x) => x.textContent === label));
const toolbar = () => document.querySelector('[data-agent-area="toolbar"]:not([data-ribbon])');
const more = (label) => toolbar()?.querySelector(`button[aria-label="${label}"]`);
function moreTools() {
  if (!more('More tools')) return;
  ids.fewer = true; // put back once the step is over
  tap(more('More tools'));
}
function fewerTools() {
  if (ids.fewer) tap(more('Fewer tools'));
  ids.fewer = false;
}
/** Tool search scrolls slowly through every tool, top to bottom (the user: all of them, all searchable). */
function scrollTools() {
  const list = search()?.querySelector('[cmdk-list]');
  if (!list || !motion('tutorial')) return;
  const [from, to, t0] = [list.scrollTop, list.scrollHeight - list.clientHeight, performance.now()];
  const step = (now) => {
    const k = Math.min(1, (now - t0) / 9000);
    list.scrollTop = from + (to - from) * k;
    if (k < 1 && list.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
const draftRow = () => (ids.draft && document.querySelector(`[data-draft="${ids.draft}"]`)) || null; // the draft lesson 1 made
const named = (sel, label) => () => [...document.querySelectorAll(sel)].find((x) => x.textContent.trim() === label) ?? null;

/** The steps of every lesson for tutorial `t` ({format, from}), in order. A step: `lesson`, its LESSONS index; `kind` click (the
 * default: a click on the target moves on; `act`, run in place of the target's own click), select (a drag over the target's
 * text, selecting within `within`, a doc range; `done` checks the selection when it ends), keys (the chord `chord` matched by `match`, its keycaps on the card, to do
 * `task`; then `onChord`), watch (`done`, checked every frame, ticks `task`), drag (`drag`, above), type (`word` typed into
 * `field`, letter by letter, nothing else), auto (no input: `script`, [ms, fn(go)] from the step's start) or look (the card's
 * `button` moves on, or its `Widget`; `next`, a lesson's end: the progress to lesson `next`, then on by itself); `target`, what
 * the light shows: a CSS selector, or a function returning one, an element or elements (null until there), with `text` only
 * as far as their text goes, `clip` within that element; `loop`, the element the light goes to and from, round and round (a
 * canvas in the page); `allow`, what takes the pointer in place of the target; `near`, what the card sits beside in place of
 * the light; `over`, the card over the light; `avoid`, rects the card keeps clear of; `point`, where the pointer goes ({x, y,
 * drag}; else the middle of the light, or of the loop's element); `pointer`, its kind when not the kind's own; `enter`, run as
 * the step starts; `hold`, run every frame while it shows; `say`, the instruction; `line`, a second line (or a function giving
 * it); `help`, its (?); `tasks`, shown ticked; `bin`, `shake`, `cheer`: the card's own small animations; `end`, the lesson's last
 * step. More: `pass` (keys: the keys it is true for go on to the app too), `only` (click: what the click must hit to count),
 * `context` (a right-click on the target opens its menu), `lines` (a talking scene in place of `say`, Tutorial.jsx Dialogue),
 * `who` (the speaker the card's header names) and `mark` (an icon: where the target is a rect, a button not there yet, the
 * card draws its dashed outline with that icon). */
export function lessons({ format, from }) {
  for (const k of Object.keys(ids)) delete ids[k];
  swing = [0, 0];
  const post = format === 'forum-post';
  const holdFor = (chord) => { const keys = chord.split('+'); return keys.length > 1 ? `Hold ${keys.slice(0, -1).join(' and ')}, then press ${keys.at(-1)}` : `Press ${chord}`; };
  const chord = keyLabel('app.quickTools') || 'Ctrl+Tab';
  const hold = holdFor(chord);
  const quick = (e) => keyIs('app.quickTools', e);
  const find = keyLabel('app.toolSearch') || 'Ctrl+Space';
  const h3 = post ? '[cmdk-item][data-value="h3"]' : '[cmdk-item][data-value="doc-style-Heading3"]';
  const tabs = [['Home', 'Home has the font and paragraph tools.'], ['Insert', 'Insert adds pictures and tables.'], ['Layout', 'Layout sets up the page.'],
    ['View', 'View changes how the page shows.']];
  // A Document's tool menu tab by tab, the user's own tab put back after; a forum post's ribbon with More tools on.
  const ribbonSteps = post
    ? [{ lesson: 4, kind: 'look', button: 'Next', enter: moreTools, target: toolbar, say: 'The ribbon',
      line: 'Every tool for your post is down here. More tools at its end shows them all.' }]
    : [...tabs.map(([tab, line], k) => ({ lesson: 4, kind: 'auto', target: ribbon, say: 'The tool menu', line, script: [[2600, (go) => go()]],
      enter: () => { if (!k) ids.tab ??= ribbon()?.querySelector('[role="tab"][data-state="active"]')?.textContent; showTab(tab)(); } })),
    { lesson: 4, kind: 'look', button: 'Next', enter: () => showTab(ids.tab ?? 'Home')(), target: ribbon, say: 'Many more tools',
      line: 'Each tab holds more. Have a look through them.' }];
  return [
    { lesson: 0, target: '[data-new-draft]', say: 'Click New draft', help: 'Everything you write in EasyWriter is a draft. The sidebar lists them.' },
    { lesson: 0, target: `[data-new-draft-format="${format}"]`, say: `Click ${post ? 'Forum post' : 'Document'}`,
      help: post ? "A forum post is written with the forum's own tools. Once it is ready, you push it to its thread."
        : 'A Document has pages, styles and a ribbon of tools, as in a word processor.' },
    { lesson: 0, target: '[role="dialog"]:has([data-new-draft-format]) [type="submit"]', say: 'Click Create',
      help: 'The title can wait. Double-click the draft in the sidebar to rename it.' },
    { lesson: 0, kind: 'look', end: true, button: 'Next', say: 'Your first draft is ready', help: 'It saves as you write.',
      target: () => {
        const s = getState();
        if (s.dialog || !s.draft?.id || s.draft.id === from) return null;
        ids.draft = s.draft.id; // the tutorial's draft, which the last lesson deletes
        return `[data-draft="${s.draft.id}"]`;
      } },

    { lesson: 1, kind: 'select', enter: writeLorem, target: lineDoms, text: true, allow: () => getState().editor?.view.dom, within: linesText, point: dragOver,
      done: selectsLines, say: 'Select these three lines', help: 'Press at the start of the first line and drag to the end of the last.' },
    { lesson: 1, kind: 'keys', target: lineDoms, text: true, avoid: menuSpace, chord, match: quick, onChord: () => openMenu(dragEnd()),
      task: 'Open the quick access menu', say: hold, help: 'You can change these keys in Settings > Keybinds.' },
    { lesson: 1, kind: 'look', button: 'Got it', target: '[data-quick-tools]', hold: holdMenu(dragEnd), say: 'This is the quick access menu',
      line: `${chord} opens it at your pointer. It holds the tools for what you are working on.`, help: 'Escape or a click outside it closes it.' },
    { lesson: 1, target: '[data-quick-tools] :is([aria-label^="Bullet list"], [aria-label^="Bullets"])', hold: holdMenu(dragEnd),
      say: `Click ${post ? 'Bullet list' : 'Bullets'}`, help: 'It turns the selected lines into a bulleted list.' },
    { lesson: 1, kind: 'look', end: true, next: 2, enter: closeQuickTools, target: listDoms, text: true, say: 'Well done',
      tasks: ['Selected three lines', 'Opened the quick access menu', 'Made them a bulleted list'] },

    { lesson: 2, enter: caretToEnd, hold: holdMenu(caretPoint), target: '[data-quick-tools] [aria-label^="Insert canvas"]',
      act: () => insertCanvas({ edit: false }), say: 'Click Insert canvas', help: 'A canvas holds drawings, shapes and flowcharts.' },
    { lesson: 2, kind: 'watch', enter: closeQuickTools, target: pageOf, clip: '#editor-area', loop: lastCanvas, allow: lastCanvas,
      done: () => !!canvasEditor.get(), say: 'Double-click the canvas', task: 'Open the canvas', help: 'A click selects it. A double-click opens it.' },
    // The canvas goes and a picture of a dog takes its place, to annotate (the user, 2026-10-27).
    { lesson: 2, kind: 'auto', over: true, bin: true, enter: () => canvasEditor.get()?.close(true), target: lastCanvas, say: 'Let me clear this up for you…',
      script: [[1300, () => lastCanvas()?.classList.add('tutorial-poof')], [1950, clearCanvas], [2350, (go) => go()]] },
    { lesson: 2, kind: 'look', target: '[data-tutorial-card]', near: endLine, Widget: DogPanel, say: 'Copy this picture', help: 'It goes into your draft next.' },
    { lesson: 2, kind: 'keys', enter: caretToEnd, target: endLine, chord: 'Ctrl+V', match: (e) => chordOf(e) === 'Ctrl+V', onChord: pasteDog,
      task: 'Paste the picture', say: 'Paste it here', help: 'The text cursor waits on a new line for it.' },
    { lesson: 2, kind: 'watch', target: pageOf, clip: '#editor-area', loop: lastCanvas, allow: lastCanvas, done: openedPicture,
      say: 'Double-click the picture', task: 'Open the picture',
      help: post ? 'A pasted picture is a canvas too.' : 'In a Document a pasted picture sits in the text. This one is in a canvas, so you can draw on it.' },
    { lesson: 2, kind: 'auto', over: true, target: boardDom, say: 'Let me decorate it a little…', script: [[1000, dropHeart], [2000, (go) => go()]] },
    { lesson: 2, kind: 'auto', shake: true, target: heartEl, say: 'Oh no!', line: 'That heart was a mistake.', script: [[2000, (go) => go()]] },
    { lesson: 2, enter: showLayers, target: '[aria-label="Layers"] ul > li:first-child > div', say: 'Click the heart in Layers',
      help: 'Layers lists what is on the canvas, the topmost first.' },
    { lesson: 2, kind: 'watch', pointer: 'click', target: '[aria-label="Board tools"] [aria-label^="Delete"]', done: () => !!ids.heart && !itemOf(ids.heart),
      say: 'Click Delete', task: 'Clean up with Layers' },
    { lesson: 2, kind: 'keys', target: boardDom, chord, match: quick, onChord: () => openMenu(menuBelowDog(), boardOf()), task: 'Open the quick access menu',
      say: hold, help: 'It opens at your pointer.' },
    { lesson: 2, kind: 'look', button: 'Got it', target: '[data-quick-tools]', hold: holdMenu(menuBelowDog, boardOf), say: 'The menu changed',
      line: 'Menus in EasyWriter follow what you are doing. In a canvas this one holds the canvas tools.', help: 'Back in the text it shows the text tools again.' },
    { lesson: 2, target: '[data-quick-tools] [aria-label^="Box"]', hold: holdMenu(menuBelowDog, boardOf), say: 'Click Box' },
    { lesson: 2, kind: 'drag', drag: drawBox, task: 'Draw a box', say: 'Drag from 1 to 2', help: 'Press at 1, hold the button down and let go at 2.' },
    { lesson: 2, kind: 'auto', cheer: true, target: boxEl, say: 'Nice, a box!', script: [[1700, (go) => go()]] },
    { lesson: 2, kind: 'drag', enter: selectBox, drag: resize('e', WIDE), say: 'Drag its right side to 2', help: 'The squares on its sides and corners resize it.' },
    { lesson: 2, kind: 'drag', enter: selectBox, drag: resize('n', TALL), say: 'Drag its top up to 2' },
    { lesson: 2, kind: 'drag', enter: selectBox, drag: resize('ne', BOX), say: 'Drag its top right corner to 2', help: 'A corner changes the width and the height together.' },
    { lesson: 2, kind: 'drag', enter: () => { selectBox(); swing = [0, 0]; }, drag: wiggle, pointer: 'wiggle', task: 'Resize and rotate a shape',
      say: 'Rotate it back and forth', help: 'Just outside a corner the pointer turns into a curved arrow. Drag there to rotate.' },
    // The board takes the pointer: its clicks go to it while it holds the pointer, so a double-click on the box lands there.
    { lesson: 2, kind: 'watch', pointer: 'double', enter: selectBox, target: boxEl, allow: boardDom, done: () => !!ids.box && boardOf()?.editingId === ids.box,
      say: 'Double-click the box', help: 'A double-click on a shape lets you type in it.' },
    { lesson: 2, kind: 'type', target: boxEl, word: 'dog', field: () => boardOf()?.editText(ids.box), finish: () => boardOf()?.finishEdit(),
      say: 'Type dog', help: 'Capitals or not, either will do.' },
    { lesson: 2, kind: 'auto', enter: bark, target: dogEl, say: 'The dog is excited!', line: "Let's annotate it.", script: [[2600, (go) => go()]] },
    { lesson: 2, kind: 'drag', enter: selectBox, drag: connect, task: 'Point the box at the dog', say: 'Drag the dot to the dog',
      help: 'The dots round a selected shape draw arrows to other things.' },
    // The arrow gets a label (the user, 2026-10-27).
    { lesson: 2, kind: 'watch', pointer: 'double', target: arrowEl, point: arrowMid, allow: boardDom, done: () => !!arrowLabel(),
      say: 'Double-click the arrow', help: 'A double-click on a line lets you write on it.' },
    { lesson: 2, kind: 'type', enter: clearLabel, target: arrowEl, word: 'this is', field: arrowLabel, finish: () => boardOf()?.finishEdit(),
      say: 'Type “this is”', help: 'Capitals or not, either will do.' },
    { lesson: 2, kind: 'look', end: true, next: 3, target: boardDom, say: 'Well done',
      tasks: ['Opened a canvas', 'Pasted a picture', 'Cleaned up with Layers', 'Drew and changed a box', 'Annotated the dog'] },

    // Tool search (the user, 2026-10-27): a heading with a click in it, then a highlight from the keyboard.
    { lesson: 3, kind: 'keys', enter: selectLazy, target: lazyDom, text: true, chord: find, match: searching, onChord: openSearch,
      task: 'Open tool search', say: holdFor(find), help: 'You can change these keys in Settings > Keybinds.' },
    { lesson: 3, kind: 'look', button: 'Got it', target: search, say: 'Tool search',
      line: 'It follows what you are doing. Text is selected, so the text tools come first.', help: 'Escape closes it.' },
    { lesson: 3, target: h3, say: 'Click Heading 3', help: 'The selected line becomes a heading.' },
    { lesson: 3, kind: 'auto', cheer: true, target: lazyDom, say: 'A heading!', line: "Still too many clicks for me. Let's be lazier.", script: [[2600, (go) => go()]] },
    { lesson: 3, kind: 'keys', enter: selectLazy, target: lazyDom, text: true, chord: find, match: searching, onChord: openSearch, Widget: Hands,
      task: 'Open tool search', say: holdFor(find) },
    { lesson: 3, kind: 'type', target: search, word: 'hi', field: searchInput, say: 'Type hi', help: 'Tool search finds a tool from its first letters.' },
    { lesson: 3, kind: 'look', button: 'Got it', target: firstTool, say: 'Highlight comes first', line: 'The best match is at the top, picked already.' },
    { lesson: 3, kind: 'keys', target: firstTool, chord: 'Tab', match: (e) => e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey,
      pass: (e) => e.key === 'Tab', task: 'Open its options', say: 'Press Tab', help: 'Tab opens the options of the picked tool.' },
    { lesson: 3, target: '[data-tool-options]', only: 'button[style*="background"]', point: swatchAt, say: 'Click a colour', help: 'The selected text takes it.' },
    { lesson: 3, kind: 'auto', cheer: true, enter: showHighlight, target: lazyDom, say: 'Boom, done!', line: 'A heading and a highlight, with hardly a click.',
      script: [[2600, (go) => go()]] },
    { lesson: 3, kind: 'look', end: true, next: 4, target: lazyDom, say: 'Well done', tasks: ['Opened tool search', 'Made a heading', 'Highlighted from the keyboard'] },

    // A look around, then goodbye (the user, 2026-10-27): the other lessons are still to come.
    { lesson: 4, kind: 'look', button: 'Show me', over: true, target: whole, say: 'More lessons are coming soon', line: 'For now, here is where everything is.' },
    { lesson: 4, kind: 'look', button: 'Next', target: '[data-agent-area="sidebar"] [aria-label="Settings"]', say: 'Settings', line: 'Change how EasyWriter looks and works here.' },
    { lesson: 4, kind: 'look', button: 'Next', target: workspaces, say: 'Plans and Flowcharts', line: 'Each opens a page of its own.' },
    { lesson: 4, kind: 'look', button: 'Next', target: chatButton, mark: MessageSquare, say: 'The assistant',
      line: () => (chatOn() ? 'Its button opens the chat.' : 'Its button shows here once you pick an assistant in Settings.') },
    { lesson: 4, kind: 'look', button: 'Next', target: micButton, mark: Mic, say: 'Dictation',
      line: () => (micOn() ? 'Its button turns what you say into text.' : 'Its button shows here once you set it up in Settings.') },
    { lesson: 4, kind: 'auto', enter: menuInText, hold: holdMenu(caretPoint), target: '[data-quick-tools]', say: 'The quick access menu',
      line: 'In text it holds the text tools.', script: [[3200, (go) => go()]] },
    { lesson: 4, kind: 'auto', enter: menuInCanvas, hold: holdMenu(menuBelowDog, boardOf), target: '[data-quick-tools]', say: 'The quick access menu',
      line: 'In a canvas it holds the canvas tools.', script: [[3200, (go) => go()]] },
    { lesson: 4, kind: 'look', button: 'Next', enter: leaveCanvas, target: pageOf, clip: '#editor-area', say: 'Many more tools',
      line: `Press ${chord} wherever you are to see them.` },
    ...ribbonSteps,
    { lesson: 4, kind: 'look', button: 'Next', enter: () => { fewerTools(); openSearch(); }, target: search, say: 'Tool search',
      line: 'Every tool in EasyWriter is in here. They work together, and you can search for any of them.', script: [[700, scrollTools]] },
    { lesson: 4, kind: 'watch', pointer: 'click', context: true, enter: closeToolSearch, target: draftRow, done: () => !!document.querySelector('[role="menu"]'),
      say: 'Right-click the tutorial draft', line: 'Time to tidy up.', help: 'Its menu also renames, moves and tags it.' },
    { lesson: 4, target: named('[role="menuitem"]', 'Delete'), say: 'Click Delete' },
    { lesson: 4, target: named('[role="alertdialog"] button', 'Delete'), say: 'Click Delete', help: 'It goes to the drafts trash folder.' },
    { lesson: 4, kind: 'look', over: true, target: whole, lines: ['All clean!', "That's everything for now.", 'Oh, and one more thing…'] },
    { lesson: 4, kind: 'look', who: 'Assistant', target: chatButton, mark: MessageSquare, lines: ['It was me all along!', "I'm your assistant.",
      () => (chatOn() ? 'Click my button down here whenever you want a hand.' : 'Pick a provider in Settings > Assistant and I can help you work.'),
      'See you around!'] },
  ];
}
