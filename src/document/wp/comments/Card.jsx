// Comment cards (docs/plans/word plan.md §3 comments, §1.7 cards and story editors): one thread with its replies, drawn beside the
// page by MarginCards and in the Comments pane. Text is drawn statically through the schema's DOMSerializer; only the comment being
// edited, or the reply being written, gets a story editor, so many threads stay cheap. A resolved thread collapses and greys out.
import { useLayoutEffect, useRef, useState } from 'react';
import { DOMSerializer, Node } from '@tiptap/pm/model';
import { MessageSquare, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tip } from '../../../app/components/Tip.jsx';
import { REASONS } from '../../../tooling/reasons.mjs';
import { mountStory } from '../../word/story.js';
import {
  deleteComment, endEdit, mainEditor, poke, postReply, selectThread, setDone, startEdit, writeContent,
} from './actions.js';
import { colorOf, isEmpty, timeAgo } from './comments.mjs';

// The hovered thread, written straight into one <style>: a hover redraws no card.
let hotEl = null;
/** Shades thread `id`'s range (from a card) or lifts its card (from the range); null clears both. */
export function setHot(id, from = 'card') {
  hotEl ??= Object.assign(document.head.appendChild(document.createElement('style')), { id: 'word-comment-hot' });
  const q = id && CSS.escape(id);
  hotEl.textContent = !id ? '' : from === 'card'
    ? `[data-doc-text] span[data-comment="${q}"] { background-color: color-mix(in srgb, var(--cmt, #e8b730) 45%, transparent); }`
    : `[data-card="comments:${q}"] [data-comment-card] { transform: translateX(-6px); box-shadow: 0 4px 14px rgb(0 0 0 / 0.25); }`;
}

/** Comment content (block JSON) drawn without an editor. */
function StaticText({ content }) {
  const box = useRef(null);
  useLayoutEffect(() => {
    const ed = mainEditor();
    if (!box.current || !ed) return;
    try {
      const doc = Node.fromJSON(ed.schema, { type: 'doc', content: content?.length ? content : [{ type: 'paragraph' }] });
      box.current.replaceChildren(DOMSerializer.fromSchema(ed.schema).serializeFragment(doc.content));
    } catch {
      box.current.textContent = '';
    }
  }, [content]);
  return <div ref={box} data-comment-text="" className="break-words [&_p]:m-0" />;
}

/** The story editor of comment `id` ('edit') or of a reply to thread `id` ('reply'): Ctrl+Enter posts, Esc leaves. */
function StoryBox({ id, mode, isNew, select, content }) {
  const host = useRef(null);
  const story = useRef(null);
  // Word's Post and Reply stay off while a new comment or a reply is empty; Save on an edit stays on.
  const gated = isNew || mode === 'reply';
  const [blank, setBlank] = useState(gated);
  const finish = (post) => {
    const s = story.current;
    if (!s) return;
    story.current = null;
    const json = s.editor.getJSON().content;
    s.destroy(); // flushes the last edit batch into the comment
    if (mode === 'reply') return post ? postReply(id, json) : endEdit();
    if (post && isNew && isEmpty(json)) {
      story.current = s; // Word's Post is off while the new comment is empty
      return;
    }
    endEdit({ cancelNew: !post });
  };
  const fin = useRef(finish);
  fin.current = finish;
  useLayoutEffect(() => {
    const s = mountStory({
      kind: 'comment', host: host.current, content: mode === 'edit' ? content : [],
      onChange: mode === 'edit' ? ({ content: c, attrs }) => writeContent(id, c, attrs) : undefined,
      onExit: () => fin.current(false),
    });
    story.current = s;
    if (gated) s.editor.on('update', () => setBlank(isEmpty(s.editor.getJSON().content)));
    const keys = (e) => {
      if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      fin.current(true);
    };
    const el = host.current;
    el.addEventListener('keydown', keys, true);
    s.focus();
    if (select) s.editor.commands.setTextSelection(select);
    return () => {
      el.removeEventListener('keydown', keys, true);
      if (story.current === s) {
        story.current = null;
        s.destroy();
      }
    };
    // Mounted once per comment and mode: the content after that is the story's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, mode]);
  const post = mode === 'reply' ? 'Reply' : isNew ? 'Post' : 'Save';
  return (
    <div className="mt-1 flex flex-col gap-1">
      <div ref={host} data-comment-story={mode} className="min-h-7 rounded-md border bg-background px-1.5 py-1 [&_.ProseMirror]:outline-none [&_p]:m-0" />
      <div className="flex justify-end gap-1">
        <Button size="xs" variant="ghost" onMouseDown={(e) => e.preventDefault()} onClick={() => fin.current(false)}>Cancel</Button>
        <Button size="xs" data-comment-action="post" disabled={gated && blank} onMouseDown={(e) => e.preventDefault()} onClick={() => fin.current(true)}>{post}</Button>
      </div>
    </div>
  );
}

/** One comment: avatar, author, time, the '...' menu and its text (or its story editor while edited). */
function Entry({ c, top, people, editing }) {
  const color = colorOf(people, c.author);
  const edited = editing?.mode === 'edit' && editing.id === c.id;
  const item = (label, action, run, extra) => (
    <DropdownMenuItem data-comment-action={action} onSelect={run} {...extra}>{label}</DropdownMenuItem>
  );
  return (
    <div data-comment-entry={c.id} className="flex flex-col">
      <div className="flex items-center gap-1.5">
        <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full text-[10px] font-semibold text-white" style={{ background: color }}>
          {c.initials || '?'}
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span data-comment-author="" className="truncate font-medium">{c.author || 'Author'}</span>
          <span className="text-[11px] text-muted-foreground">{timeAgo(c.date)}</span>
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-xs" variant="ghost" aria-label="More thread actions" data-comment-action="menu" onMouseDown={(e) => e.stopPropagation()}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          {/* No focus back to the trigger: Edit comment's story editor takes it, and the other items remove the trigger. */}
          <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
            {item('Edit comment', 'edit', () => startEdit(c.id))}
            {item(top ? 'Delete thread' : 'Delete comment', 'delete', () => deleteComment(c.id))}
            {top && item('Resolve thread', 'resolve', () => setDone(c.id, true))}
            <Tip title={REASONS.cloud} side="left" wrap="w-full">{item('Link to comment', 'link', () => {}, { disabled: true })}</Tip>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {edited ? <StoryBox id={c.id} mode="edit" isNew={editing.isNew} select={editing.select} content={c.content} />
        : <div className="mt-1 pl-7.5"><StaticText content={c.content} /></div>}
    </div>
  );
}

/** A thread card: the first comment, its replies and the Reply box; collapsed with Reopen once resolved. */
export function ThreadCard({ thread, editing, active, inPane = false }) {
  const ed = mainEditor();
  const people = ed?.state.doc.attrs.people;
  const replying = editing?.mode === 'reply' && editing.id === thread.id;
  // A resolved thread stays open while one of its comments is edited (x.reveal.comment from find).
  const collapsed = thread.done && !(editing && [thread.id, ...thread.replies.map((r) => r.id)].includes(editing.id));
  const activate = (e) => {
    if (e.target.closest('button, [data-comment-story], [role="menu"]')) return;
    if (inPane) selectThread(thread);
    else if (!active) poke(ed, { active: thread.id });
  };
  return (
    <div data-comment-card={thread.id} data-done={thread.done || undefined} data-active={active || undefined} tabIndex={inPane ? -1 : undefined}
      onMouseEnter={() => setHot(thread.id)} onMouseLeave={() => setHot(null)} onMouseDown={activate}
      className={`flex flex-col gap-2 rounded-md border bg-card p-2 text-[13px] text-card-foreground shadow-sm transition-transform ${
        active ? 'border-ring' : ''} ${thread.done ? 'opacity-60' : ''}`}>
      {collapsed ? (
        <>
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{thread.author}: resolved</span>
            <Button size="xs" variant="ghost" data-comment-action="reopen" onClick={() => setDone(thread.id, false)}>Reopen</Button>
          </div>
        </>
      ) : (
        <>
          <Entry c={thread} top people={people} editing={editing} />
          {thread.replies.map((r) => <Entry key={r.id} c={r} people={people} editing={editing} />)}
          {replying ? <StoryBox id={thread.id} mode="reply" />
            : !(editing?.isNew && editing.id === thread.id) && (
              <button type="button" data-comment-action="reply" onClick={() => startEdit(thread.id, 'reply')}
                className="rounded-md border bg-background px-2 py-1 text-left text-muted-foreground hover:bg-accent">Reply</button>
            )}
        </>
      )}
    </div>
  );
}

/** A margin card: the thread card, or only its icon while Show Comments is off (a click shows that card). */
export function MarginCard({ card, active }) {
  if (card.icon) {
    return (
      <Button size="icon-xs" variant="ghost" aria-label={`Show comment by ${card.thread.author ?? 'Author'}`} data-comment-icon={card.id}
        onClick={() => poke(mainEditor(), { opened: card.id, active: card.id })}>
        <MessageSquare className="size-4" />
      </Button>
    );
  }
  return <ThreadCard thread={card.thread} editing={card.editing} active={active} />;
}

