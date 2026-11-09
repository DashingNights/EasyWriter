// The node view of sdtInline and sdtBlock (plan.md §1.2 Node views, §1.8 sdt object), for every control, also the ones other
// packages insert (citation, bibliography, docPart). The content stays editable text; around it the view draws the appearance
// (a bounding box with a title tab while the caret is inside, start and end tags, or nothing), a drop-down arrow, a check box's
// click, a picture's placeholder and a repeating section's plus button. Chrome elements are contenteditable false and their
// events stay away from ProseMirror.
import { Calendar } from '../../../components/ui/calendar.jsx';
import { galleryOf, panelOf, run, ctxOf } from '../../../tooling/registry.js';
import { BLOCK_GALLERIES } from '../../ribbon/spec.mjs';
import { addRepeatingItem, flags, pickDate, pickItem, sdtOf, selectContent, toggleCheck } from './ops.js';
import { PickList, popover } from './pop.jsx';

const TYPE_NAMES = { richText: 'Rich Text', text: 'Plain Text', picture: 'Picture', checkbox: 'Check Box', comboBox: 'Combo Box', dropDown: 'Drop-Down List',
  date: 'Date Picker', docPart: 'Building Block', citation: 'Citation', bibliography: 'Bibliography', group: 'Group', repeating: 'Repeating Section',
  repeatingItem: 'Repeating Item' };
const ARROW = new Set(['comboBox', 'dropDown', 'date']);

/** A chrome element: not editable, not part of the content. */
function chrome(tag, cls) {
  const el = document.createElement(tag);
  el.className = cls;
  el.contentEditable = 'false';
  return el;
}

/** Whether `node` holds a leaf other than text (a picture). */
function hasLeaf(node) {
  let found = false;
  node.descendants((n) => {
    found ||= n.isLeaf && !n.isText;
    return !found;
  });
  return found;
}

/** The title tab's menu key (§1.8): sdt.type for citation and bibliography, else the docPart gallery; null without one. */
const menuKey = (s) => (s.type === 'citation' || s.type === 'bibliography' ? s.type : s.type === 'docPart' ? s.docPart?.gallery ?? null : null);

export class SdtView {
  constructor(node, view, getPos) {
    this.view = view;
    this.getPos = getPos;
    this.node = node;
    const tag = node.type.name === 'sdtInline' ? 'span' : 'div';
    this.dom = document.createElement(tag);
    this.dom.className = 'cc';
    this.dom.setAttribute('data-sdt', '');
    this.tab = chrome('span', 'cc-tab');
    this.title = document.createElement('span');
    this.menu = document.createElement('span');
    this.menu.className = 'cc-menu';
    this.menu.textContent = '▾';
    this.tab.append(this.title, this.menu);
    this.start = chrome('span', 'cc-tag cc-start');
    this.end = chrome('span', 'cc-tag cc-end');
    this.contentDOM = document.createElement(tag);
    this.contentDOM.className = 'cc-body';
    this.arrow = chrome('span', 'cc-arrow');
    this.arrow.textContent = '▾';
    this.plus = chrome('span', 'cc-plus');
    this.plus.textContent = '+';
    this.plus.title = 'Add a section';
    this.dom.append(this.tab, this.start, this.contentDOM, this.arrow, this.end, this.plus);
    this.onDown = this.onDown.bind(this);
    this.dom.addEventListener('mousedown', this.onDown);
    this.render();
  }

  render() {
    const s = sdtOf(this.node);
    const d = this.dom.dataset;
    d.type = s.type;
    d.appearance = s.appearance;
    if (s.showingPlaceholder) d.placeholder = '';
    else delete d.placeholder;
    if (s.type === 'picture' && !hasLeaf(this.node)) d.bare = '';
    else delete d.bare;
    if (s.color) this.dom.style.setProperty('--cc-color', s.color);
    else this.dom.style.removeProperty('--cc-color');
    const name = s.title || s.tag || TYPE_NAMES[s.type] || 'Content control';
    this.title.textContent = s.title ?? '';
    this.tab.hidden = !s.title && !menuKey(s);
    this.menu.hidden = !menuKey(s);
    // Start/End Tag shows the title alone in the start tag and nothing in the end tag, as Word prints it; Design Mode names both.
    const tags = s.appearance === 'tags';
    this.start.textContent = tags ? (s.title ?? '') : name;
    this.end.textContent = tags ? '' : name;
    this.arrow.hidden = !ARROW.has(s.type);
    this.plus.hidden = !(s.type === 'repeating' && s.repeat?.allowAddRemove !== false);
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  // Our own chrome changes and the attribute updates are not content.
  ignoreMutation(m) {
    if (m.type === 'selection') return false;
    return !this.contentDOM.contains(m.target) && m.target !== this.contentDOM;
  }

  stopEvent(e) {
    return !!e.target?.closest && !this.contentDOM.contains(e.target) && this.dom.contains(e.target);
  }

  destroy() {
    this.dom.removeEventListener('mousedown', this.onDown);
  }

  onDown(e) {
    if (e.button !== 0) return;
    const pos = this.getPos();
    if (pos == null) return;
    const s = sdtOf(this.node);
    const { view } = this;
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (this.plus.contains(e.target)) {
      stop();
      addRepeatingItem(view, pos);
    } else if (this.arrow.contains(e.target)) {
      stop();
      openList(view, pos, this.dom);
    } else if (this.tab.contains(e.target) && menuKey(s)) {
      stop();
      openTabMenu(view, pos, this.tab);
    } else if (s.type === 'checkbox' && this.contentDOM.contains(e.target) && !flags.design) {
      stop();
      toggleCheck(view, pos);
    } else if (s.type === 'picture' && s.showingPlaceholder && this.dom.contains(e.target)) {
      stop();
      selectContent(view, pos);
      ctxOf().T.image?.onClick?.(); // the picker Insert > Pictures uses; the picture lands on the selection, inside the control
    }
  }
}

/** The drop-down of a Combo Box or Drop-Down List (its items), or a Date Picker's calendar. */
export function openList(view, pos, anchor) {
  const node = view.state.doc.nodeAt(pos);
  if (!node) return;
  const s = sdtOf(node);
  if (s.type === 'date') {
    const full = s.date?.full ? new Date(s.date.full) : null;
    const day = full && new Date(full.getUTCFullYear(), full.getUTCMonth(), full.getUTCDate());
    popover(anchor, (close) => (
      <div data-cc-calendar="">
        <Calendar mode="single" selected={day ?? undefined} defaultMonth={day ?? undefined} onSelect={(d) => {
          if (d) pickDate(view, pos, d);
          close();
          view.focus();
        }} />
      </div>
    ));
    return;
  }
  const text = node.textContent;
  popover(anchor, (close) => (
    <PickList items={s.items.map((it) => ({ label: it.display, active: !s.showingPlaceholder && it.display === text }))} onPick={(i) => {
      pickItem(view, pos, i);
      close();
      view.focus();
    }} />
  ));
}

/** The title tab's menu: a registered panel 'sdt:<key>', else a docPart control's gallery items (G9: a pick selects the
 * control's content and runs the item). */
function openTabMenu(view, pos, anchor) {
  const s = sdtOf(view.state.doc.nodeAt(pos));
  const key = menuKey(s);
  const Panel = panelOf(`sdt:${key}`);
  if (Panel) {
    popover(anchor, (close) => <Panel ctx={ctxOf()} cmd={null} close={close} />);
    return;
  }
  if (s.type !== 'docPart') return;
  const id = BLOCK_GALLERIES[s.docPart?.gallery] ?? null;
  const items = id ? galleryOf(id, ctxOf()).filter((it) => !s.docPart?.category || !it.group || it.group === s.docPart.category) : [];
  popover(anchor, (close) => (
    <PickList empty="This gallery has no building blocks yet." items={items.map((it) => ({ label: it.label }))} onPick={(i) => {
      close();
      selectContent(view, pos);
      const it = items[i];
      if (it.run) it.run(ctxOf());
      else run(id, it.id);
    }} />
  ));
}
