// The AutoCorrect Options button (docs/plans/word plan.md §1.7 overlay, index-editing.md line 107 and 137): a small blue bar under
// the start of the last automatic change; pointing at it shows the lightning button, whose menu changes it back, stops the rule
// and opens the AutoCorrect dialog. Drawn as plain DOM in the page overlay; it goes with the next edit (plugin.js clears it).
import { ctxOf } from '../../../tooling/registry.js';
import { layoutY, overlayOf, scaleOf } from '../../geometry.js';
import { saveWord } from '../../word/settings.mjs';
import { DEFAULT_ENTRIES } from './entries.mjs';

// Word's item labels per kind: [undo label, stop label, settings group and key the Stop item turns off, dialog tab]. The capital
// rules each have their own Stop item; replacements and spelling take the typed word.
const FORMAT = 'autoFormatAsYouType';
const KINDS = {
  quote: ['Undo Smart Quotes', 'Stop Automatically Replacing Straight Quotes with Smart Quotes', 'autoformat', 'quotes', FORMAT],
  ordinal: ['Undo Superscript', 'Stop Automatically Superscripting Ordinals', 'autoformat', 'ordinals', FORMAT],
  fraction: ['Undo Fraction', 'Stop Automatically Replacing Fractions', 'autoformat', 'fractions', FORMAT],
  dash: ['Undo Dash', 'Stop Automatically Replacing Hyphens with Dashes', 'autoformat', 'dashes', FORMAT],
  boldItalic: ['Undo Formatting', 'Stop Automatically Formatting *Bold* and _Italic_', 'autoformat', 'boldItalic', FORMAT],
  link: ['Undo Hyperlink', 'Stop Automatically Creating Hyperlinks', 'autoformat', 'links', FORMAT],
  bullets: ['Undo Automatic Bullets', 'Stop Automatically Creating Bulleted Lists', 'autoformat', 'bulletedLists', FORMAT],
  numbering: ['Undo Automatic Numbering', 'Stop Automatically Creating Numbered Lists', 'autoformat', 'numberedLists', FORMAT],
  border: ['Undo Border Line', 'Stop Automatically Creating Border Lines', 'autoformat', 'borders', FORMAT],
  table: ['Undo Table', 'Stop Automatically Creating Tables', 'autoformat', 'tables', FORMAT],
  heading: ['Undo Heading', 'Stop Automatically Applying Heading Styles', 'autoformat', 'headings', FORMAT],
};
const CAPITALS = {
  sentences: 'Stop Auto-capitalizing First Letter of Sentences',
  cells: 'Stop Auto-capitalizing First Letter of Table Cells',
  days: 'Stop Auto-capitalizing Names of Days',
  twoCaps: 'Stop Automatically Correcting Two Initial Capitals',
  capsLock: 'Stop Automatically Correcting Caps Lock',
};

/** The menu items of automatic change `auto` → [[id, label, action(editor)]]. */
export function itemsOf(auto, undo) {
  const ac = () => ctxOf().settings.word.autocorrect;
  const control = (tab) => ['control', tab === FORMAT ? 'Control AutoFormat Options...' : 'Control AutoCorrect Options...',
    () => ctxOf().dialog('autoCorrect', { tab })];
  if (auto.kind === 'replace' || auto.kind === 'spelling') {
    return [
      ['undo', `Change back to "${auto.before}"`, undo],
      ['stop', `Stop Automatically Correcting "${auto.before}"`, () => {
        const a = ac();
        if (auto.kind === 'spelling') return saveWord({ autocorrect: { exceptions: { ...a.exceptions, other: [...(a.exceptions.other ?? []), auto.before] } } });
        const name = auto.before.toLowerCase();
        return saveWord({ autocorrect: { entries: (a.entries ?? DEFAULT_ENTRIES).filter((e) => e.name.toLowerCase() !== name) } });
      }],
      control('autoCorrect'),
    ];
  }
  if (auto.kind === 'capital') {
    return [
      ['undo', 'Undo Automatic Capitalization', undo],
      ['stop', CAPITALS[auto.rule] ?? CAPITALS.sentences, () => saveWord({ autocorrect: { [auto.rule ?? 'sentences']: false } })],
      control('autoCorrect'),
    ];
  }
  const k = KINDS[auto.kind];
  if (!k) return [['undo', 'Undo', undo], control('autoCorrect')];
  return [['undo', k[0], undo], ['stop', k[1], () => saveWord({ [k[2]]: { [k[3]]: false } })], control(k[4])];
}

const LIGHTNING = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M9 1 3 9h4l-1 6 6-8H8z" fill="currentColor"/></svg>';

/** Draws the button for automatic change `auto` (plugin state) in `view`'s page overlay, or removes it when `auto` is null;
 * `undoAuto(editor)` undoes the change. */
export function drawButton(editor, view, auto, undoAuto) {
  const doc = view.dom.ownerDocument;
  const host = view.dom.parentElement;
  host?.querySelector(':scope > #page-overlay > [data-ac-button]')?.remove();
  if (!auto || !view.dom.isConnected || view.isDestroyed) return;
  const overlay = overlayOf(view);
  if (!overlay) return;
  let x;
  let y;
  try {
    const c = view.coordsAtPos(Math.min(auto.from, view.state.doc.content.size));
    x = (c.left - view.dom.getBoundingClientRect().left) / scaleOf(view);
    y = layoutY(view, auto.from) + (c.bottom - c.top) / 2 / scaleOf(view);
  } catch {
    return;
  }
  const el = doc.createElement('div');
  el.dataset.acButton = auto.kind;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.innerHTML = `<span data-ac-bar></span><button type="button" data-ac-open aria-label="AutoCorrect Options" title="AutoCorrect Options">${LIGHTNING}</button>`;
  const undo = () => {
    view.focus();
    undoAuto(editor);
  };
  const open = (e) => {
    e?.preventDefault();
    if (el.querySelector('[role="menu"]')) return;
    const menu = doc.createElement('div');
    menu.setAttribute('role', 'menu');
    for (const [id, label, act] of itemsOf(auto, undo)) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.dataset.acItem = id;
      b.textContent = label;
      b.addEventListener('mousedown', (m) => m.preventDefault()); // the caret stays in the text
      b.addEventListener('click', () => {
        el.remove();
        if (id !== 'control') view.focus();
        act(editor);
      });
      menu.append(b);
    }
    el.append(menu);
  };
  el.querySelector('[data-ac-open]').addEventListener('mousedown', open);
  el.addEventListener('mouseleave', () => el.querySelector('[role="menu"]')?.remove());
  overlay.append(el);
}
