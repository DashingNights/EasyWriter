// Insert Hyperlink (probe/dialogs/insert-hyperlink.json; Insert > Link, Ctrl+K): Link to Existing File or Web Page, Place in This
// Document, Create New Document (drawn, disabled: a draft has no address another file could link to) and E-mail Address; Text to
// display, ScreenTip..., Bookmark..., Target Frame... and, on an existing link, Remove Link. The sub-dialogs stack through openDialog.
import { getMarkRange } from '@tiptap/core';
import { cn } from 'cn';
import { Bookmark, FilePlus2, Globe, Mail } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { openDialog } from '../../../app/actions.js';
import { targetEditor } from '../../../tooling/registry.js';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { Pick, rowClass, TextArea } from '../../../tooling/kit/controls.jsx';
import { bookmarksOf, listedBookmarks, refName } from './bookmarks.mjs';
import { Label } from './BookmarkDialog.jsx';
import { bookmarkTr } from './edit.js';
import { mailHref, mailParts } from './refs.mjs';
import { refAround, targetsOf } from './xref.mjs';

const PAGES = [['file', 'E&xisting File or Web Page', Globe], ['place', 'Pl&ace in This Document', Bookmark], ['new', 'Create &New Document', FilePlus2],
  ['email', 'E-&mail Address', Mail]];
/** Word's target frames (Set Target Frame): value → label. */
export const FRAMES = [['', 'Page Default (none)'], ['_self', 'Same frame'], ['_top', 'Whole page'], ['_blank', 'New window'], ['_parent', 'Parent frame']];

/** The links of `doc`: [{href, anchor}] in document order, each address once. */
export function linksOf(doc) {
  const seen = new Set();
  const out = [];
  doc.descendants((n) => {
    const m = n.isText && n.marks.find((x) => x.type.name === 'link');
    if (m && !seen.has(m.attrs.href)) {
      seen.add(m.attrs.href);
      out.push({ href: m.attrs.href, anchor: m.attrs.anchor });
    }
  });
  return out;
}

/** The places of `doc` the tree offers: Top of the Document, the headings, the visible bookmarks → [{id, label, group, depth}]. */
export function placesOf(doc) {
  return [{ id: '_top', label: 'Top of the Document', depth: 0 },
    { id: null, label: 'Headings', depth: 0, group: true },
    ...targetsOf(doc, 'heading').map((h) => ({ id: `heading:${h.from}`, label: h.label.trim(), depth: 1 + (h.label.length - h.label.trimStart().length) / 2, from: h.from, to: h.to })),
    { id: null, label: 'Bookmarks', depth: 0, group: true },
    ...listedBookmarks(doc).map((b) => ({ id: b.name, label: b.name, depth: 1 }))];
}

/** The places on a canvas draft, from the engine's link.targets ({headings: [{block, level, text}], bookmarks: [name]}). */
export function enginePlaces(t) {
  return [{ id: '_top', label: 'Top of the Document', depth: 0 },
    { id: null, label: 'Headings', depth: 0, group: true },
    ...(t?.headings ?? []).map((h) => ({ id: `heading:${h.block}`, label: h.text, depth: Math.max(1, h.level ?? 1), block: h.block })),
    { id: null, label: 'Bookmarks', depth: 0, group: true },
    ...(t?.bookmarks ?? []).map((b) => ({ id: b, label: b, depth: 1 }))];
}

/** The tree of places: a list box with group headings. */
function PlaceTree({ places, value, onChange, id }) {
  return (
    <div id={id} role="listbox" tabIndex={0} className="h-40 overflow-auto rounded-md border border-input bg-background text-xs">
      {places.map((p, i) => (
        <div key={`${p.id}-${i}`} role={p.group ? 'presentation' : 'option'} aria-selected={!p.group && p.id === value} data-place={p.id ?? undefined}
          onClick={() => !p.group && onChange(p.id)} style={{ paddingLeft: `${0.5 + p.depth}rem` }}
          className={cn('cursor-default truncate py-0.5 pr-1.5', p.group ? 'font-medium text-muted-foreground' : rowClass(p.id === value))}>{p.label}</div>
      ))}
    </div>
  );
}

/** Set Hyperlink ScreenTip → the text, or null on Cancel. */
export function ScreenTipDialog({ value = '', onClose }) {
  const [text, setText] = useState(value ?? '');
  return (
    <WordDialog title="Set Hyperlink ScreenTip" size="sm" onClose={onClose} result={() => text}>
      <Label htmlFor="fr-screentip" label="Scree&nTip text:" />
      <TextArea id="fr-screentip" value={text} onChange={(e) => setText(e.target.value)} autoFocus rows={3} />
    </WordDialog>
  );
}

/** Select Place in Document (Bookmark...) → the place id, or null. */
export function SelectPlaceDialog({ editor = targetEditor(), places: given = null, value = null, onClose }) {
  const places = useMemo(() => given ?? placesOf(editor.state.doc), [editor, given]);
  const [place, setPlace] = useState(value ?? '_top');
  return (
    <WordDialog title="Select Place in Document" size="sm" onClose={onClose} result={() => place}>
      <Label htmlFor="fr-select-place" label="Select an e&xisting place in the document:" />
      <PlaceTree id="fr-select-place" places={places} value={place} onChange={setPlace} />
    </WordDialog>
  );
}

/** Set Target Frame → the target ('' for the page default), or null. */
export function TargetFrameDialog({ value = '', onClose }) {
  const [target, setTarget] = useState(value ?? '');
  return (
    <WordDialog title="Set Target Frame" size="sm" onClose={onClose} result={() => target}>
      <Label htmlFor="fr-target" label="&Select the frame you want the document to appear in:" />
      <Pick id="fr-target" value={target} options={FRAMES} onChange={setTarget} />
    </WordDialog>
  );
}

// What the dialog edits: the existing link around the selection, or the selection. `plain`: the range is text inside one paragraph,
// so Text to display can replace it (Word greys the box when the selection holds more than text).
function startOf(editor) {
  const { state } = editor;
  const type = state.schema.marks.link;
  const { from, to } = state.selection;
  const $from = state.doc.resolve(from);
  const marks = [...$from.marks(), ...($from.nodeAfter?.marks ?? [])];
  const mark = marks.find((m) => m.type === type) ?? null;
  const range = mark ? getMarkRange($from, type) ?? { from, to } : { from, to };
  let plain = state.doc.resolve(range.from).sameParent(state.doc.resolve(range.to));
  state.doc.nodesBetween(range.from, range.to, (n) => {
    // Bookmark markers do not count: applyLink keeps them around the new text.
    if (n.isInline && !n.isText && n.type.name !== 'bookmark') plain = false;
  });
  return { range, mark: mark ? mark.attrs : null, text: state.doc.textBetween(range.from, range.to, ' '), plain };
}

/** Writes link `attrs` ({href, anchor, tooltip, target}) with display text `text` over `range` of `editor`, continuing `tr` when given
 * (a hidden bookmark added in the same step). */
export function applyLink(editor, attrs, { range = editor.state.selection, text = null, plain = true, tr = editor.state.tr } = {}) {
  const { schema } = editor.state;
  const type = schema.marks.link;
  const mark = type.create({ ...attrs });
  const from = tr.mapping.map(range.from, 1);
  const to = Math.max(from, tr.mapping.map(range.to, -1));
  const old = tr.doc.textBetween(from, to, ' ');
  if (from === to) {
    tr.insert(from, schema.text(text || attrs.href, [...tr.doc.resolve(from).marks().filter((m) => m.type !== type), mark]));
  } else if (plain && text && text !== old) {
    const marks = tr.doc.resolve(from).marksAcross(tr.doc.resolve(to)) ?? [];
    // Bookmark markers in the range stay, starts before the new text and ends after it, so a bookmark or a heading's _Ref survives.
    const kept = [];
    tr.doc.nodesBetween(from, to, (n) => {
      if (n.type.name === 'bookmark') kept.push(n);
    });
    tr.replaceWith(from, to, [...kept.filter((n) => !n.attrs.end), schema.text(text, [...marks.filter((m) => m.type !== type), mark]),
      ...kept.filter((n) => n.attrs.end)]);
  } else {
    tr.removeMark(from, to, type).addMark(from, to, mark);
  }
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
}

const withScheme = (href) => (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') ? href : `https://${href}`);

// On a canvas draft (`engine`: {targets: link.targets, text: the selected text}) the dialog reads the engine's places and returns
// what to link ({url} | {bookmark} | {heading} | {top}, and text) for the command to write; ScreenTip and Target Frame are not on
// the canvas yet (gap G48).
export function HyperlinkDialog({ editor = targetEditor(), engine = null, onClose }) {
  const start = useMemo(() => (engine ? { range: null, mark: null, text: engine.text ?? '', plain: true } : startOf(editor)), [editor, engine]);
  const old = start.mark ?? {};
  const oldPlace = old.anchor ?? (old.href?.startsWith('#') ? old.href.slice(1) : null);
  const oldMail = old.href?.startsWith('mailto:') ? mailParts(old.href) : null;
  const [page, setPage] = useState(oldMail != null ? 'email' : oldPlace != null ? 'place' : 'file');
  const [text, setText] = useState(start.text);
  const [address, setAddress] = useState(oldMail == null && oldPlace == null ? old.href ?? '' : '');
  const [place, setPlace] = useState(oldPlace);
  const [email, setEmail] = useState(oldMail?.address ?? '');
  const [subject, setSubject] = useState(oldMail?.subject ?? '');
  const [tooltip, setTooltip] = useState(old.tooltip ?? null);
  const [target, setTarget] = useState(old.target ?? '');
  const doc = editor?.state.doc;
  const places = useMemo(() => (engine ? enginePlaces(engine.targets) : placesOf(doc)), [doc, engine]);
  const links = useMemo(() => (doc ? linksOf(doc) : []), [doc]);
  const recent = links.filter((l) => l.href && !l.href.startsWith('#') && !l.href.startsWith('mailto:')).map((l) => l.href);
  const mails = [...new Set(links.filter((l) => l.href?.startsWith('mailto:')).map((l) => mailParts(l.href).address))];

  const ready = page === 'file' ? !!address.trim() : page === 'place' ? !!place : page === 'email' ? !!email.trim() : false;
  const result = () => {
    if (engine) {
      const shown = text || (page === 'email' ? email.trim() : places.find((p) => p.id === place)?.label ?? '');
      const heading = places.find((p) => p.id === place && p.block != null);
      const to = page === 'email' ? { url: mailHref(email.trim(), subject) } : page !== 'place' ? { url: withScheme(address.trim()) }
        : place === '_top' ? { top: true } : heading ? { heading: heading.block } : { bookmark: place };
      return { ...to, ...(shown ? { text: shown } : {}) };
    }
    let attrs;
    let tr = editor.state.tr;
    if (page === 'place') {
      let name = place;
      const heading = places.find((p) => p.id === place && p.from != null);
      if (heading) {
        // A heading gets a hidden _Ref bookmark (Word's own naming is unverified), added in the same step as the link.
        name = refAround(bookmarksOf(editor.state.doc), heading) ?? refName(editor.state.doc);
        if (!refAround(bookmarksOf(editor.state.doc), heading)) tr = bookmarkTr(editor.state, name, heading);
      }
      attrs = { href: `#${name}`, anchor: name };
    } else if (page === 'email') {
      attrs = { href: mailHref(email.trim(), subject), anchor: null };
    } else attrs = { href: withScheme(address.trim()), anchor: null };
    const shown = text || (page === 'email' ? email.trim() : page === 'place' ? (places.find((p) => p.id === place)?.label ?? attrs.href) : attrs.href);
    applyLink(editor, { ...attrs, tooltip: tooltip || null, target: target || null }, { range: start.range, text: shown, plain: start.plain, tr });
    return attrs;
  };
  const sub = async (id, props, set) => {
    const v = await openDialog(id, props);
    if (v != null) set(v);
  };
  const box = 'h-6 text-xs';

  return (
    <WordDialog title={start.mark ? 'Edit Hyperlink' : 'Insert Hyperlink'} size="lg" onClose={onClose} result={result}
      validate={() => (ready ? null : page === 'new' ? 'Creating a new document from a link is not available.' : 'Give an address first.')}
      left={start.mark ? [{ label: '&Remove Link', onClick: () => {
        editor.chain().focus().setTextSelection(start.range).unsetMark('link').run();
        onClose(null);
      } }] : []}>
      <div className="flex gap-3">
        <div className="flex w-32 shrink-0 flex-col gap-1">
          <span>Link to:</span>
          {PAGES.map(([id, label, Icon]) => (
            <button key={id} type="button" role="radio" aria-checked={page === id} data-link-to={id} onClick={() => setPage(id)} {...accessProps(label)}
              className={cn('flex flex-col items-center gap-1 rounded-md border px-1 py-2 text-center text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                page === id ? 'border-primary bg-accent' : 'border-transparent hover:bg-accent')}>
              <Icon className="size-5" /><AccessText label={label} />
            </button>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center gap-2">
            <Label htmlFor="fr-link-text" label="&Text to display:" />
            <Input id="fr-link-text" className={cn(box, 'flex-1')} value={text} disabled={!start.plain} onChange={(e) => setText(e.target.value)} />
            <Button type="button" variant="outline" size="sm" disabled={!!engine} onClick={() => sub('setHyperlinkScreenTip', { value: tooltip }, setTooltip)} {...accessProps('ScreenTi&p...')}>
              <AccessText label="ScreenTi&p..." />
            </Button>
          </div>
          {page === 'file' && (
            <>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" disabled title="Not available yet">Browse the Web</Button>
                <Button type="button" variant="outline" size="sm" disabled title="Not available yet">Browse for File</Button>
              </div>
              <span className="text-muted-foreground">Addresses already linked in this document:</span>
              <div role="listbox" className="h-28 overflow-auto rounded-md border border-input bg-background text-xs">
                {recent.map((href) => (
                  <div key={href} role="option" aria-selected={href === address} onClick={() => setAddress(href)}
                    className={cn('cursor-default truncate px-1.5 py-0.5', rowClass(href === address))}>{href}</div>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="fr-link-address" label="Addr&ess:" />
                <Input id="fr-link-address" className={cn(box, 'flex-1')} value={address} autoFocus list="fr-link-recent" onChange={(e) => setAddress(e.target.value)} />
                <datalist id="fr-link-recent">{recent.map((href) => <option key={href} value={href} />)}</datalist>
              </div>
            </>
          )}
          {page === 'place' && (
            <>
              <Label htmlFor="fr-link-place" label="Sele&ct a place in this document:" />
              <PlaceTree id="fr-link-place" places={places} value={place} onChange={setPlace} />
            </>
          )}
          {page === 'new' && (
            <>
              <Label htmlFor="fr-link-new" label="Name of new &document:" />
              <Input id="fr-link-new" className={box} disabled />
              <p className="text-muted-foreground">A draft has no file address for a link to point at, so this is not available.</p>
            </>
          )}
          {page === 'email' && (
            <>
              <Label htmlFor="fr-link-email" label="&E-mail address:" />
              <Input id="fr-link-email" className={box} value={email} autoFocus onChange={(e) => setEmail(e.target.value.replace(/^mailto:/i, ''))} />
              <Label htmlFor="fr-link-subject" label="S&ubject:" />
              <Input id="fr-link-subject" className={box} value={subject} onChange={(e) => setSubject(e.target.value)} />
              <span>Recently used e-mail addresses:</span>
              <div role="listbox" className="h-20 overflow-auto rounded-md border border-input bg-background text-xs">
                {mails.map((m) => (
                  <div key={m} role="option" aria-selected={m === email} onClick={() => setEmail(m)}
                    className={cn('cursor-default truncate px-1.5 py-0.5', rowClass(m === email))}>{m}</div>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="flex w-28 shrink-0 flex-col gap-2 pt-8">
          {page === 'file' && (
            <Button type="button" variant="outline" size="sm" {...accessProps('B&ookmark...')} onClick={() => sub('selectPlaceInDocument', { editor, value: place, ...(engine && { places }) }, (v) => {
              setPlace(v);
              setPage('place');
            })}><AccessText label="B&ookmark..." /></Button>
          )}
          {page !== 'email' && (
            <Button type="button" variant="outline" size="sm" disabled={!!engine} {...accessProps('Tar&get Frame...')} onClick={() => sub('setTargetFrame', { value: target }, setTarget)}>
              <AccessText label="Tar&get Frame..." />
            </Button>
          )}
        </div>
      </div>
    </WordDialog>
  );
}

