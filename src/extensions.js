import { Extension, Mark, Node } from '@tiptap/core';
import { AllSelection, Plugin, TextSelection } from '@tiptap/pm/state';
import { columnResizingPluginKey, TableMap } from '@tiptap/pm/tables';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { contentWidth, injectStyle, make, WhiteboardPaste } from './whiteboard.js';
import { Canvas, scaleOf } from './canvas.js';
import { PlanChart } from './plan-chart.js';
import { CopyPicture, drawnColumnWidths, setColumnWidths } from './export.js';
import { FONT_SIZES, FONTS, HIGHLIGHTS, presetChain, TEXT_COLORS } from './format.mjs';
import { keyAmong } from './app/keybinds.js';
import { chordOf } from './app/keys.mjs';

export { FONT_SIZES, FONTS, HIGHLIGHTS, TEXT_COLORS }; // defined in format.mjs, which the command catalogue imports too

// Parse rules return null (accept) or false (reject) so values the forum would drop are not kept.
// `consuming: false` lets one <span> carry several marks (e.g. pasted spans with colour + size).
const accept = (ok) => (ok ? null : false);

const findFont = (name) => {
  const key = String(name).trim().replace(/^["']|["']$/g, '').toLowerCase();
  return FONTS.find((f) => f.css.toLowerCase() === key || f.label.toLowerCase() === key);
};

export const FontSize = Mark.create({
  name: 'fontSize',
  addAttributes() {
    return {
      size: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-ips-font-size'),
        renderHTML: (attrs) => ({ 'data-ips-font-size': attrs.size }),
      },
    };
  },
  parseHTML() {
    return [{
      tag: 'span[data-ips-font-size]',
      consuming: false,
      getAttrs: (el) => accept(FONT_SIZES.map(String).includes(el.getAttribute('data-ips-font-size'))),
    }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', HTMLAttributes, 0];
  },
  addCommands() {
    return {
      setFontSize: (size) => ({ commands }) =>
        size == null || String(size) === '100'
          ? commands.unsetMark(this.name)
          : commands.setMark(this.name, { size: String(size) }),
      unsetFontSize: () => ({ commands }) => commands.unsetMark(this.name),
    };
  },
});

export const TextColor = Mark.create({
  name: 'textColor',
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-i-color'),
        renderHTML: (attrs) => ({ 'data-i-color': attrs.color }),
      },
    };
  },
  parseHTML() {
    return [{
      tag: 'span[data-i-color]',
      consuming: false,
      getAttrs: (el) => {
        const key = el.getAttribute('data-i-color');
        return accept(key !== 'root' && Object.hasOwn(TEXT_COLORS, key));
      },
    }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', HTMLAttributes, 0];
  },
  addCommands() {
    return {
      setTextColor: (key) => ({ commands }) =>
        key == null || key === 'root'
          ? commands.unsetMark(this.name)
          : commands.setMark(this.name, { color: key }),
      unsetTextColor: () => ({ commands }) => commands.unsetMark(this.name),
    };
  },
});

export const Highlight = Mark.create({
  name: 'highlight',
  addAttributes() {
    return {
      color: {
        default: 'yellow',
        parseHTML: (el) => el.getAttribute('data-i-background-color') || 'yellow',
        renderHTML: (attrs) => ({ 'data-i-background-color': attrs.color }),
      },
    };
  },
  parseHTML() {
    return [{
      tag: 'mark',
      getAttrs: (el) => {
        const key = el.getAttribute('data-i-background-color');
        return accept(key === null || HIGHLIGHTS.includes(key));
      },
    }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['mark', HTMLAttributes, 0];
  },
  addCommands() {
    return {
      setHighlight: (key) => ({ commands }) =>
        key ? commands.setMark(this.name, { color: key }) : commands.unsetMark(this.name),
      unsetHighlight: () => ({ commands }) => commands.unsetMark(this.name),
    };
  },
});

export const FontFamily = Mark.create({
  name: 'fontFamily',
  addAttributes() {
    return {
      font: {
        default: null,
        parseHTML: (el) => findFont(el.style.fontFamily.split(',')[0])?.css ?? null,
        renderHTML: ({ font }) => (font
          ? { style: `font-family: ${font.includes(' ') ? `"${font}"` : font}` }
          : {}),
      },
    };
  },
  parseHTML() {
    return [{
      tag: 'span[style*="font-family"]',
      consuming: false,
      getAttrs: (el) => accept(findFont(el.style.fontFamily.split(',')[0])),
    }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', HTMLAttributes, 0];
  },
  addCommands() {
    return {
      setFontFamily: (css) => ({ commands }) =>
        css ? commands.setMark(this.name, { font: css }) : commands.unsetMark(this.name),
      unsetFontFamily: () => ({ commands }) => commands.unsetMark(this.name),
    };
  },
});

const MEDIA_MIN = 40; // display width
const CORNERS = ['nw', 'ne', 'sw', 'se'];

// The editor view of a media node: a click selects it (the video's controls still work); its corner handles change the
// display width `dw` (the height follows the video or picture), live in the DOM and one commit on pointerup.
class MediaView {
  constructor({ node, view, getPos, editor }) {
    Object.assign(this, { node, view, getPos, editor, drag: null, dw: node.attrs.dw });
    injectStyle(); // .wb-handle
    const { src, name } = node.attrs;
    this.dom = make('div');
    this.dom.dataset.media = '';
    this.el = src?.startsWith('data:video/') ? make('video', '', { src, controls: true, preload: 'metadata' }) : make('img', '', { src, alt: name });
    this.dom.append(this.el);
    this.dom.addEventListener('pointerdown', this.onPointerDown);
    this.dom.addEventListener('pointermove', this.onPointerMove);
    this.dom.addEventListener('pointerup', this.onPointerUp);
    this.dom.addEventListener('pointercancel', this.onPointerUp);
    this.size();
  }

  size() {
    this.el.style.width = this.dw ? `${this.dw}px` : '';
  }

  onPointerDown = (e) => {
    if (e.button !== 0) return;
    const corner = CORNERS.find((c) => e.target.classList.contains(`wb-h-${c}`));
    if (!corner) {
      const pos = this.getPos();
      if (typeof pos === 'number') this.editor.commands.setNodeSelection(pos);
      this.view.focus();
      return;
    }
    e.preventDefault();
    this.drag = { sign: corner.includes('w') ? -1 : 1, x: e.clientX, w0: this.el.offsetWidth, scale: scaleOf(this.dom) };
    e.target.setPointerCapture(e.pointerId);
  };

  onPointerMove = (e) => {
    const g = this.drag;
    if (!g) return this.dom.style.setProperty('--wb-inv', String(1 / scaleOf(this.dom))); // the page zoom may have changed
    this.dw = Math.round(Math.max(MEDIA_MIN, Math.min(g.w0 + (g.sign * (e.clientX - g.x)) / g.scale, contentWidth(this.view))));
    this.size();
  };

  onPointerUp = () => {
    if (!this.drag) return;
    this.drag = null;
    const pos = this.getPos();
    if (this.dw !== this.node.attrs.dw && typeof pos === 'number') {
      this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, dw: this.dw }));
    }
  };

  update(node) {
    if (node.type !== this.node.type || node.attrs.src !== this.node.attrs.src) return false;
    this.node = node;
    if (!this.drag) {
      this.dw = node.attrs.dw;
      this.size();
    }
    return true;
  }

  // Everything inside is ours, except paste/drop, which must reach WhiteboardPaste's handlers.
  stopEvent(event) {
    return !['paste', 'drop', 'dragover', 'dragenter', 'dragleave'].includes(event.type);
  }

  ignoreMutation() {
    return true;
  }

  selectNode() {
    if (this.dom.classList.contains('media-selected')) return;
    this.dom.classList.add('media-selected');
    this.dom.append(...CORNERS.map((c) => make('div', `wb-handle wb-h-${c}`, { title: 'Drag to resize' })));
    this.dom.style.setProperty('--wb-inv', String(1 / scaleOf(this.dom)));
  }

  deselectNode() {
    this.dom.classList.remove('media-selected');
    for (const h of this.dom.querySelectorAll(':scope > .wb-handle')) h.remove();
  }
}

// A video or GIF: pushed to the forum as its own file (export.js buildPayload), since a canvas would flatten it to one frame.
export const Media = Node.create({
  name: 'media',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      src: { default: null, rendered: false },
      name: { default: 'media', rendered: false },
      dw: { default: null, rendered: false }, // display width in post px; null: its own width, at most the content width
    };
  },
  parseHTML() {
    return [{
      tag: 'div[data-media]',
      getAttrs: (el) => {
        const src = el.firstElementChild?.getAttribute('src') ?? '';
        const dw = Math.round(Number(el.getAttribute('data-dw'))) || null;
        return /^data:(image|video)\//.test(src) ? { src, name: el.getAttribute('data-name') || 'media', dw } : false;
      },
    }];
  },
  renderHTML({ node: { attrs: { src, name, dw } } }) {
    const style = dw ? `width: ${dw}px` : null;
    const el = src?.startsWith('data:video/') ? ['video', { src, controls: '', preload: 'metadata', style }] : ['img', { src, alt: name, style }];
    return ['div', { 'data-media': '', 'data-name': name, 'data-dw': dw }, el];
  },
  addNodeView() {
    return (props) => new MediaView(props);
  },
});

export const BoxTitle = Node.create({
  name: 'boxTitle',
  content: 'inline*',
  parseHTML() {
    return [{
      tag: 'div.ipsRichTextBox__title',
      contentElement: (el) => el.querySelector(':scope > p') ?? el,
    }];
  },
  renderHTML() {
    return ['div', { class: 'ipsRichTextBox__title' }, ['p', 0]];
  },
});

export const BoxContent = Node.create({
  name: 'boxContent',
  content: 'block+',
  parseHTML() {
    return [{ tag: 'i-richtext-box-content' }];
  },
  renderHTML() {
    return ['i-richtext-box-content', { class: 'ipsRichText' }, 0];
  },
});

export const Box = Node.create({
  name: 'box',
  group: 'block',
  content: 'boxTitle boxContent',
  defining: true,
  parseHTML() {
    return [{ tag: 'div.ipsRichTextBox' }];
  },
  renderHTML() {
    return ['div', { class: 'ipsRichTextBox ipsRichTextBox--alwaysopen' }, 0];
  },
  addCommands() {
    return {
      // Wraps the selected blocks in a box; empty, cell or node selections get an empty box.
      insertBox: () => ({ state, commands }) => {
        const { selection, schema } = state;
        const box = (body) => ({
          type: this.name,
          content: [
            { type: 'boxTitle', content: [{ type: 'text', text: 'Title' }] },
            { type: 'boxContent', content: body },
          ],
        });
        // Nearest whole-block range whose parent can start with a box (skips list item, list, row and box levels).
        const range = selection instanceof TextSelection && !selection.empty
          && selection.$from.blockRange(selection.$to, (p) => p.type.contentMatch.matchType(schema.nodes[this.name]));
        if (!range) return commands.insertContent(box([{ type: 'paragraph' }]));
        const body = state.doc.slice(range.start, range.end).content.toJSON();
        return commands.insertContentAt({ from: range.start, to: range.end }, box(body));
      },
    };
  },
});

/** A text selection stays visible while the editor is not focused (tool search, the chat panel or a menu has the focus):
 * drawn as .inactive-sel (page.css), since the browser hides a selection outside the focused element (SPEC §7c). */
export const InactiveSelection = Extension.create({
  name: 'inactiveSelection',
  addProseMirrorPlugins() {
    const { editor } = this;
    return [new Plugin({
      props: {
        decorations: ({ doc, selection: s }) => (editor.isFocused || s.empty || !(s instanceof TextSelection || s instanceof AllSelection) ? null
          : DecorationSet.create(doc, [Decoration.inline(s.from, s.to, { class: 'inactive-sel' })])),
      },
    })];
  },
});

// The text shortcuts (SPEC §7k): a chord bound to one of these runs it, before TipTap's own keymaps (higher priority); a chord
// TipTap binds to one of them that the user has moved does nothing. TipTap's other keys (Enter, Backspace, Tab in lists and
// tables, Shift+Enter) stay its own.
const TEXT_KEYS = {
  'edit.undo': (c) => c.undo(),
  'edit.redo': (c) => c.redo(),
  'text.bold': (c) => c.toggleBold(),
  'text.italic': (c) => c.toggleItalic(),
  'text.underline': (c) => c.toggleUnderline(),
  'text.strike': (c) => c.toggleStrike(),
  'text.code': (c) => c.toggleCode(),
  'text.subscript': (c) => c.toggleSubscript(),
  'text.superscript': (c) => c.toggleSuperscript(),
  'text.paragraph': (c) => c.setParagraph(),
  ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((level) => [`text.heading${level}`, (c) => c.toggleHeading({ level })])),
  'text.bulletList': (c) => c.toggleBulletList(),
  'text.orderedList': (c) => c.toggleOrderedList(),
  'text.blockquote': (c) => c.toggleBlockquote(),
  'text.codeBlock': (c) => c.toggleCodeBlock(),
  'text.alignLeft': (c) => c.setTextAlign('left'),
  'text.alignCenter': (c) => c.setTextAlign('center'),
  'text.alignRight': (c) => c.setTextAlign('right'),
  'text.alignJustify': (c) => c.setTextAlign('justify'),
};
const TEXT_IDS = Object.keys(TEXT_KEYS);
// TipTap's chords for those commands (StarterKit, TextAlign, Subscript, Superscript; Mod-B and the like also take Shift).
const TIPTAP_CHORDS = new Set(['Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z', 'Ctrl+B', 'Ctrl+Shift+B', 'Ctrl+I', 'Ctrl+Shift+I', 'Ctrl+U', 'Ctrl+Shift+U',
  'Ctrl+Shift+S', 'Ctrl+E', 'Ctrl+Alt+C', 'Ctrl+Shift+8', 'Ctrl+Shift+7', 'Ctrl+,', 'Ctrl+.', 'Ctrl+Shift+L', 'Ctrl+Shift+E', 'Ctrl+Shift+R',
  'Ctrl+Shift+J', ...[0, 1, 2, 3, 4, 5, 6].map((n) => `Ctrl+Alt+${n}`)]);

const TextKeys = Extension.create({
  name: 'textKeys',
  priority: 1100,
  addProseMirrorPlugins() {
    const { editor } = this;
    return [new Plugin({
      props: {
        handleKeyDown(_view, event) {
          const id = keyAmong(TEXT_IDS, event);
          if (id) {
            TEXT_KEYS[id](editor.chain()).run();
            return true;
          }
          return TIPTAP_CHORDS.has(chordOf(event));
        },
      },
    })];
  },
});

const MIN_COLUMN = 20; // the forum editor's cellMinWidth (SPEC §1)

// Dragging a table column border. Table's columnResizing still finds the border under the pointer (its handle); this drag
// runs ahead of its own, which adds the pointer's screen px to unzoomed widths and lets the other columns reflow. Here the
// border stays under the pointer: the column right of it gives or takes the width (the right edge resizes the table), and
// on release every column keeps its width, in one undo step.
export const ColumnDrag = Extension.create({
  name: 'columnDrag',
  priority: 101, // before Table's mousedown
  addProseMirrorPlugins() {
    const mousedown = (view, event) => {
      const handle = columnResizingPluginKey.getState(view.state)?.activeHandle ?? -1;
      if (handle < 0 || event.button !== 0) return false;
      const $cell = view.state.doc.resolve(handle);
      const table = $cell.node(-1);
      const pos = $cell.before(-1);
      const widths = drawnColumnWidths(view, table, pos);
      const el = view.nodeDOM(pos)?.querySelector(':scope > table');
      if (!widths || !el) return false;
      const col = TableMap.get(table).colCount($cell.pos - $cell.start(-1)) + $cell.nodeAfter.attrs.colspan - 1;
      const scale = el.getBoundingClientRect().width / el.offsetWidth; // the page's zoom
      const { doc } = view.state;
      const win = view.dom.ownerDocument.defaultView;
      const widthsAt = (x) => {
        const room = col + 1 < widths.length ? widths[col + 1] - MIN_COLUMN : Infinity;
        const d = Math.round(Math.min(Math.max((x - event.clientX) / scale, MIN_COLUMN - widths[col]), room));
        return widths.map((w, i) => (i === col ? w + d : i === col + 1 ? w - d : w));
      };
      const finish = (e) => {
        win.removeEventListener('mousemove', move);
        win.removeEventListener('mouseup', finish);
        const tr = view.state.tr.setMeta(columnResizingPluginKey, { setDragging: null });
        view.dispatch(view.state.doc === doc ? setColumnWidths(tr, table, pos, widthsAt(e.clientX)) : tr);
      };
      const move = (e) => {
        if (!e.buttons) return finish(e);
        const next = widthsAt(e.clientX);
        el.querySelectorAll(':scope > colgroup > col').forEach((c, i) => Object.assign(c.style, { width: `${next[i]}px`, minWidth: '' }));
        Object.assign(el.style, { width: `${next.reduce((a, b) => a + b)}px`, minWidth: '' });
      };
      // Dragging stops columnResizing moving its handle under the pointer.
      view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setDragging: { startX: event.clientX, startWidth: widths[col] } }));
      win.addEventListener('mousemove', move);
      win.addEventListener('mouseup', finish);
      event.preventDefault();
      return true;
    };
    return [new Plugin({ props: { handleDOMEvents: { mousedown } } })];
  },
});

/** `historyDepth`: the undo steps the history keeps (§7e). */
export function buildExtensions(historyDepth) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
      undoRedo: { depth: historyDepth },
    }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Subscript,
    Superscript,
    Table.configure({ resizable: true, cellMinWidth: MIN_COLUMN }), // the forum editor's own settings (SPEC §1)
    ColumnDrag,
    TableRow,
    TableHeader,
    TableCell,
    FontSize,
    TextColor,
    Highlight,
    FontFamily,
    Box,
    BoxTitle,
    BoxContent,
    WhiteboardPaste,
    Canvas,
    PlanChart,
    Media,
    CopyPicture,
    InactiveSelection,
    TextKeys,
  ];
}

/** Replaces the selection's character formatting with the preset's, in one chain (one undo step). */
export function applyPreset(editor, preset) {
  return presetChain(editor.chain().focus(), preset).run();
}
