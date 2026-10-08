import { Editor, Extension, Node } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { level } from '../dictation/dictation.js';
import { ATTACH_CHARS } from './attach.mjs';

// The chat panel's text box (SPEC §7i): a small TipTap editor with paragraphs, line breaks and two inline atoms. Enter sends,
// Shift+Enter breaks the line. The pill is an attachment (attach.mjs) that moves and deletes like one word; the waveform marks
// where dictation goes while the mic is held, then shows a quiet working state until the final text replaces it.

export const PILL_CLASS = 'mx-px inline-block rounded-md border bg-secondary px-1.5 align-baseline text-xs leading-5 whitespace-nowrap text-secondary-foreground select-none';

const pillData = (el) => {
  try {
    const d = JSON.parse(el.dataset.pill);
    return typeof d?.label === 'string' ? { data: { kind: String(d.kind), label: d.label.slice(0, 60), body: String(d.body ?? '').slice(0, ATTACH_CHARS) } } : false;
  } catch {
    return false;
  }
};

const Pill = Node.create({
  name: 'pill',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  addAttributes: () => ({ data: { default: null, rendered: false } }),
  parseHTML: () => [{ tag: 'span[data-pill]', getAttrs: pillData }],
  renderHTML: ({ node }) => ['span', { 'data-pill': JSON.stringify(node.attrs.data), class: PILL_CLASS }, node.attrs.data?.label ?? ''],
  renderText: ({ node }) => `[${node.attrs.data?.label}]`,
});

const BARS = 12;

/** The waveform's view: live level bars from the mic (dictation.js level()), newest on the right; working: flat, pulsing. */
function waveView(node) {
  const dom = document.createElement('span');
  dom.className = 'mx-0.5 inline-flex h-[1lh] items-center gap-[2px] align-top';
  dom.setAttribute('role', 'img');
  const bars = Array.from({ length: BARS }, () => dom.appendChild(Object.assign(document.createElement('span'), { className: 'h-[3px] w-[2px] rounded-full bg-foreground/80' })));
  const levels = new Array(BARS).fill(0);
  const paint = () => bars.forEach((b, i) => { b.style.height = `${3 + levels[i] * 11}px`; });
  let working = false;
  const setWorking = (on) => {
    working = on;
    if (on) { // flat at once
      levels.fill(0);
      paint();
    }
    dom.dataset.wave = on ? 'working' : 'live';
    dom.setAttribute('aria-label', on ? 'Transcribing' : 'Dictating');
    dom.classList.toggle('animate-pulse', on);
  };
  setWorking(node.attrs.working);
  let last = 0;
  let frame = 0;
  const draw = (now) => {
    if (now - last > 45) {
      last = now;
      levels.shift();
      levels.push(working ? 0 : Math.min(1, Math.sqrt(level()) * 2.2));
      paint();
    }
    frame = requestAnimationFrame(draw);
  };
  frame = requestAnimationFrame(draw);
  return {
    dom,
    update(n) {
      if (n.type !== node.type) return false;
      setWorking(n.attrs.working);
      return true;
    },
    destroy: () => cancelAnimationFrame(frame),
    ignoreMutation: () => true,
  };
}

const Wave = Node.create({
  name: 'wave',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  addAttributes: () => ({ working: { default: false, rendered: false } }),
  renderHTML: () => ['span', { 'data-wave': '' }],
  renderText: () => '',
  addNodeView: () => ({ node }) => waveView(node),
});

const Keys = Extension.create({
  name: 'chatKeys',
  priority: 1000, // before StarterKit's Enter and Mod-Enter
  addOptions: () => ({ submit: () => {} }),
  addKeyboardShortcuts() {
    const submit = () => {
      this.options.submit();
      return true;
    };
    // A pill next to the caret goes as one character would (the browser's own delete of an uneditable span is less sure).
    const dropPill = (back) => () => {
      const { selection: s } = this.editor.state;
      const n = s.empty && (back ? s.$from.nodeBefore : s.$from.nodeAfter);
      if (n?.type.name !== 'pill') return false;
      return this.editor.commands.deleteRange(back ? { from: s.from - n.nodeSize, to: s.from } : { from: s.from, to: s.from + n.nodeSize });
    };
    return { Enter: submit, 'Mod-Enter': submit, Backspace: dropPill(true), Delete: dropPill(false) };
  },
});

const OFF = ['blockquote', 'bold', 'bulletList', 'code', 'codeBlock', 'dropcursor', 'gapcursor', 'heading', 'horizontalRule', 'italic', 'link',
  'listItem', 'listKeymap', 'orderedList', 'strike', 'underline', 'trailingNode'];

const images = (list) => [...(list ?? [])].filter((f) => f.type.startsWith('image/'));

/** The text box in `element`, holding `content` (TipTap JSON); `submit()` on Enter, `onChange(editor)` on every content change,
 * `onImages(files)` for image files pasted or dropped into it (they go to the tray above the box, not into the text). */
export const chatEditor = ({ element, content, submit, onChange, onImages, attributes }) => new Editor({
  element,
  content,
  extensions: [StarterKit.configure(Object.fromEntries(OFF.map((k) => [k, false]))), Pill, Wave, Keys.configure({ submit })],
  editorProps: {
    attributes: { 'data-chat-input': '', role: 'textbox', 'aria-multiline': 'true', ...attributes },
    handlePaste: (_, e) => (images(e.clipboardData?.files).length ? (onImages(images(e.clipboardData.files)), true) : false),
    handleDrop: (_, e) => (images(e.dataTransfer?.files).length ? (onImages(images(e.dataTransfer.files)), true) : false),
  },
  onUpdate: ({ editor }) => onChange(editor),
});

const PICTURE_MAX = 1568; // px on the long side of an attached image as the model gets it
const THUMB = 96; // px on the long side of its thumbnail in the tray and the sent message

/** `bmp` drawn at most `max` px on its long side on a white ground (no alpha: llama.cpp drops it) → {url (JPEG data URL), w, h}. */
async function encode(bmp, max, quality) {
  const f = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const [w, h] = [Math.max(1, Math.round(bmp.width * f)), Math.max(1, Math.round(bmp.height * f))];
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, h);
  g.drawImage(bmp, 0, 0, w, h);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality });
  const url = await new Promise((ok, no) => Object.assign(new FileReader(), { onload: (e) => ok(e.target.result), onerror: no }).readAsDataURL(blob));
  return { url, w, h };
}

/** An image file the user attached (paste, drop or the Attach button) as an attachment (attach.mjs) for the tray: `picture()`
 * gives the model the image (assistant.js pictures), `thumb` is what the tray and the sent message show. null when it does not
 * decode. `n` numbers its label. */
export async function imageAttachment(file, n) {
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const [pic, thumb] = [await encode(bmp, PICTURE_MAX, 0.9), await encode(bmp, THUMB * 2, 0.8)];
    const size = `${pic.w} x ${pic.h} px`;
    return {
      id: crypto.randomUUID(), kind: 'image', label: `Image ${n}`, thumb: thumb.url,
      body: `A picture the user attached (${file.name || 'pasted'}, ${size}). It follows below.`,
      picture: async () => ({ url: pic.url, size }),
    };
  } finally {
    bmp.close();
  }
}

/** The box's content as message parts (attach.mjs): its text (a line break as \n) and the pills' attachments, trimmed. */
export function partsOf(doc) {
  const parts = [];
  const add = (p) => (typeof p === 'string' && typeof parts.at(-1) === 'string' ? (parts[parts.length - 1] += p) : parts.push(p));
  doc.forEach((block, _, i) => {
    if (i) add('\n');
    block.forEach((n) => add(n.isText ? n.text : n.type.name === 'hardBreak' ? '\n' : n.type.name === 'pill' ? n.attrs.data : ''));
  });
  if (typeof parts[0] === 'string') parts[0] = parts[0].trimStart();
  if (typeof parts.at(-1) === 'string') parts[parts.length - 1] = parts.at(-1).trimEnd();
  return parts.filter((p) => p !== '');
}

/** The selection's attachment (SPEC §7i Attachments) in the tray above the box (`tray`: {get(), set(list)}, 2026-10-07: the
 * attachments moved out of the text): put first in the tray when the box gains the focus while `capture()` (capture.js
 * captureSelection) finds something selected, replaced when the selection changes elsewhere (`follow`, while the box is not
 * focused), removed when it goes. One the user removes (`removed(att)`, the tray's X) stays away for that selection. An auto
 * attachment already in the tray (kept while the panel was closed) is adopted. → {follow(), release(), removed(att)} (release:
 * it is no longer the auto one, e.g. sent). */
export function autoPill(ed, capture, tray) {
  const keyOf = (a) => (a ? `${a.kind}\n${a.body}` : null);
  let id = null;
  let key = null;
  let dismissed = null; // the selection whose attachment the user removed
  const read = () => {
    try {
      return capture();
    } catch {
      return null; // never in the way of the focus
    }
  };
  const adopted = tray.get().find((x) => x.auto);
  if (adopted) [id, key] = [adopted.id, keyOf(adopted)];
  const sync = (a) => {
    const k = keyOf(a);
    if (k !== dismissed) dismissed = null;
    if (k === key || ed.isDestroyed) return;
    let list = id ? tray.get().filter((x) => x.id !== id) : tray.get();
    id = null;
    key = null;
    const had = list.some((x) => keyOf(x) === k); // the tray holds it already (tool search's)
    if (a && !dismissed && !had) {
      id = crypto.randomUUID();
      key = k;
      list = [{ ...a, id, auto: true }, ...list];
    }
    if (list !== tray.get()) tray.set(list);
  };
  // A click moves the focus before the box hears it, and the board the click leaves stops being the active one meanwhile
  // (whiteboard.js updateActive): the selection is read at the pointer-down.
  let early;
  ed.view.dom.addEventListener('pointerdown', () => {
    if (ed.view.hasFocus()) return;
    early = read();
    setTimeout(() => { early = undefined; });
  }, true);
  ed.on('focus', () => sync(early !== undefined ? early : read()));
  return {
    follow: () => { if (id && !ed.view.hasFocus()) sync(read()); },
    release: () => {
      id = null;
      key = null;
    },
    removed: (att) => {
      if (att.id !== id) return;
      dismissed = key;
      id = null;
      key = null;
    },
  };
}

/** Message parts as the box's inline content (TipTap JSON). */
export const inlineOf = (parts) => parts.flatMap((p) => (typeof p !== 'string' ? [{ type: 'pill', attrs: { data: p } }]
  : p.split('\n').flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : [])])));

const wavePos = (doc) => {
  let pos = null;
  doc.descendants((n, p) => (n.type.name === 'wave' ? ((pos = p), false) : pos === null));
  return pos;
};

/** Dictation into the box: the waveform at the selection, in place of selected text (kept, for when nothing is said). Neither
 * it nor its removal is an undo step: the final text is one, replacing the selection as typing would. → the session
 * {working() (released: read-only until the end), end(text) (the final text, or nothing)}. */
export function dictateInto(ed) {
  const { state } = ed;
  const kept = state.selection.content();
  ed.view.dispatch(state.tr.replaceSelectionWith(state.schema.nodes.wave.create(), false).setMeta('addToHistory', false));
  let at = null; // the focus at the release
  return {
    working() {
      const pos = wavePos(ed.state.doc);
      if (ed.isDestroyed || pos === null) return false;
      at = document.activeElement;
      ed.view.dispatch(ed.state.tr.setNodeAttribute(pos, 'working', true).setMeta('addToHistory', false));
      ed.setEditable(false);
      return true;
    },
    end(text) {
      if (ed.isDestroyed) return;
      ed.setEditable(true);
      const pos = wavePos(ed.state.doc);
      if (pos === null) return;
      const back = ed.state.tr.replace(pos, pos + 1, kept).setMeta('addToHistory', false);
      ed.view.dispatch(back);
      if (text) {
        const from = back.mapping.map(pos, -1);
        const to = back.mapping.map(pos + 1, 1);
        const { doc } = ed.state;
        const [$a, $b] = [doc.resolve(from), doc.resolve(to)];
        const before = from > $a.start() ? doc.textBetween(from - 1, from, '\n', 'x') : '';
        const after = to < $b.end() ? doc.textBetween(to, to + 1, '\n', 'x') : '';
        const said = `${before && !/\s/.test(before) ? ' ' : ''}${text}${after && !/\s/.test(after) ? ' ' : ''}`;
        const tr = ed.state.tr.insertText(said, from, to);
        ed.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + said.length - (after && !/\s/.test(after) ? 1 : 0))));
      }
      // The focus to the box, unless the user moved it elsewhere while the text was transcribed.
      const now = document.activeElement;
      if (!at || now === at || now === document.body) ed.view.focus();
    },
  };
}

/** Removes any waveform (the panel closed mid-dictation), so the kept content never holds one. */
export function dropWaves(ed) {
  for (let pos = wavePos(ed.state.doc); pos !== null; pos = wavePos(ed.state.doc)) ed.view.dispatch(ed.state.tr.delete(pos, pos + 1).setMeta('addToHistory', false));
}
