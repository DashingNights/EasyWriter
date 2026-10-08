import { Extension, Mark, Node } from '@tiptap/core';
import { AllSelection, Plugin, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { Whiteboard, WhiteboardPaste } from './whiteboard.js';
import { Canvas } from './canvas.js';
import { PlanChart } from './plan-chart.js';
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
    Table.configure({ resizable: false }),
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
    Whiteboard,
    WhiteboardPaste,
    Canvas,
    PlanChart,
    InactiveSelection,
    TextKeys,
  ];
}

/** Replaces the selection's character formatting with the preset's, in one chain (one undo step). */
export function applyPreset(editor, preset) {
  return presetChain(editor.chain().focus(), preset).run();
}
