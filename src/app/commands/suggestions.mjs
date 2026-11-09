import { pathOfPos } from '../../doc-path.mjs';
import { cardOf, stepFrom } from '../../suggest/cards.mjs';
import { describe, edited, entries } from '../../suggest/core.mjs';
import { activeOf, decisions, resolve, setActive } from '../../suggest/extension.js';
import { define, fail } from './define.mjs';
import { DRAFT_ID } from './schema-defs.mjs';
import { scrollToBlock } from './ui.mjs';

// suggestions.* (docs/wiki/suggestions.md Agent commands for the new buttons): what waits in a draft as an agent's suggestion,
// accepting and rejecting it (actions.resolveSuggestions, as the review cards do), showing one, and an outside agent's group
// note. No command changes settings.assistant.autoApproveEdits: agents never change their own policy. On a canvas draft the
// suggestions are the engine's cards (src/suggest/canvas.js): a change id there is 'r' and a revision id, which execAs reports.

const CHANGE_ID = { type: 'string', pattern: '^(s[0-9a-z]{1,12}|r[0-9]{1,9})$' };
const GROUP_ID = { type: 'string', pattern: '^g[0-9a-z]{1,12}$', description: 'A group id from suggestions_list' };
const ROWS = 5; // change rows on the approval card

/** The position of the block a change sits at (a deletion: the block its widget sits beside), or null for page setup. */
function blockPos(doc, e) {
  if (e.kind === 'attr') return null;
  if (e.kind !== 'delete') return e.starts[0];
  return e.side === 'after' ? e.from - (doc.resolve(e.from).nodeBefore?.nodeSize ?? 0) : e.from;
}

const brief = (doc, schema, e) => {
  const pos = blockPos(doc, e);
  return { id: e.id, group: e.g, by: e.by, at: e.at, note: e.note, kind: e.kind, summary: describe(e, schema), path: pos == null ? null : pathOfPos(doc, pos) };
};

/** The engine's cards (src/suggest/canvas.js) when draft `draft`'s suggestions are the engine's, through ctx.actions: this file
 * also loads where no browser module does (the catalogue's node tests). → that API, or null. */
const engineOf = (ctx, draft) => {
  const e = ctx.actions?.engineSuggestions;
  return e?.onEngine(draft) ? e : null;
};

/** A canvas draft's card as a suggestions_list row: its revisions are the ids execAs reported. */
const cardBrief = (c) => ({ id: c.id, group: c.g, by: c.by, at: c.at, note: null, kind: c.kind, summary: c.text, revisions: c.revs.map((r) => `r${r}`) });

/** suggestions.resolve on a canvas draft: as below, on its cards. */
async function resolveCards(ctx, a, draftId, { freshCards }) {
  const all = await freshCards(draftId);
  const picked = a.all ? all : a.group ? all.filter((c) => c.g === a.group) : [...new Set(a.ids.map((id) => cardOf(all, id)).filter(Boolean))];
  const missing = a.ids?.filter((id) => !cardOf(all, id)) ?? [];
  if (!picked.length || missing.length) {
    fail('not_found', `${missing.length ? `No suggestion ${missing.join(', ')} waits` : 'No suggestion matches'} in this draft. suggestions_list shows what waits`);
  }
  const agent = ctx.source.startsWith('agent:') && !ctx.autoApprove();
  if (agent) {
    const touched = picked.some((c) => c.edited);
    if (!(a.action === 'reject' && !touched && picked.every((c) => c.by === ctx.source))) {
      const n = picked.length;
      const rows = picked.slice(0, ROWS).map((c) => c.text);
      if (n > ROWS) rows.push(`and ${n - ROWS} more`);
      if (touched && a.action === 'reject') rows.push('You edited this suggestion. Rejecting it also removes your edits.');
      const title = `${a.action} ${n === 1 ? 'a suggestion' : `${n} suggestions`} in the draft "${ctx.state.draft?.title || 'Untitled draft'}"`;
      if (!(await ctx.ask(title, rows.join('\n'), { risk: 'approval' }))) fail('denied', 'The user denied the request', { reason: 'user' });
    }
  }
  // The approval card stands in for the edited-suggestion confirm.
  const resolved = await ctx.actions.resolveCanvasSuggestions(draftId, { ids: picked.map((c) => c.id) }, a.action, { by: ctx.source, confirm: !agent });
  if (resolved === null) fail('cancelled', 'The user kept the suggestions');
  return { action: a.action, resolved, waiting: (await freshCards(draftId)).length };
}

// A decision's word: an author rejecting its own suggestion withdrew it.
const verb = (d) => (d.action === 'accept' ? 'accepted' : d.by === d.author ? 'withdrawn' : 'rejected');

export const defs = [
  define({
    id: 'suggestions.list',
    title: 'List the suggestions waiting in a draft and what the user decided',
    brief: 'Agent edits wait as suggestions until the user accepts or rejects them. draftId: another draft; leave it out for the open draft.',
    group: 'suggestions',
    risk: 'read',
    undo: 'none',
    canvas: true, // the engine's cards, not the hidden DOM editor (commands.js failedGates)
    needs: ['doc.open'],
    args: { type: 'object', additionalProperties: false, properties: { draftId: DRAFT_ID } },
    result: { type: 'object', required: ['pending', 'decisions'] },
    examples: [{ args: {} }],
    run: async (ctx) => {
      const draftId = ctx.state.draft?.id ?? null;
      const log = decisions().filter((d) => d.draftId === draftId)
        .map((d) => ({ ids: d.ids, group: d.g, author: d.author, by: d.by, decision: verb(d), at: d.at }));
      const eng = engineOf(ctx, ctx.state.draft);
      if (eng) return { draftId, pending: (await eng.freshCards(draftId)).map(cardBrief), decisions: log };
      const { doc, schema } = ctx.editor.state;
      return { draftId, pending: entries(doc).map((e) => brief(doc, schema, e)), decisions: log };
    },
  }),
  define({
    id: 'suggestions.resolve',
    title: 'Accept or reject suggestions in a draft',
    brief: 'Rejecting your own suggestions runs at once. Anything else asks the user in the app. draftId: another draft; leave it out for the open draft.',
    notFor: 'making a change. Edit the draft and it waits as a new suggestion',
    group: 'suggestions',
    risk: 'write', // asks in its run (commands.js SELF_ASK) unless the agent withdraws its own unedited suggestions
    undo: 'doc',
    canvas: true, // the engine's cards, not the hidden DOM editor (commands.js failedGates)
    needs: ['doc.open'],
    args: {
      type: 'object', required: ['action'], additionalProperties: false,
      properties: {
        action: { enum: ['accept', 'reject'], description: 'accept keeps the change, reject takes it back' },
        ids: { type: 'array', items: CHANGE_ID, minItems: 1, maxItems: 200, description: 'Change ids from suggestions_list' },
        group: GROUP_ID,
        all: { enum: [true], description: 'Every suggestion in the draft' },
        draftId: DRAFT_ID,
      },
      oneOf: [{ required: ['ids'] }, { required: ['group'] }, { required: ['all'] }],
    },
    result: { type: 'object', required: ['action', 'resolved', 'waiting'] },
    examples: [{ args: { action: 'reject', ids: ['s7k2a1'] } }, { args: { action: 'accept', group: 'g3m9x0' } }, { args: { action: 'accept', all: true } }],
    run: async (ctx, a) => {
      const draftId = ctx.state.draft?.id ?? null;
      const eng = engineOf(ctx, ctx.state.draft);
      if (eng) return resolveCards(ctx, a, draftId, eng);
      const ed = ctx.editor;
      const { doc, schema } = ed.state;
      const all = entries(doc);
      const picked = a.all ? all : a.group ? all.filter((e) => e.g === a.group) : all.filter((e) => a.ids.includes(e.id));
      const missing = a.ids?.filter((id) => !all.some((e) => e.id === id)) ?? [];
      if (!picked.length || missing.length) {
        fail('not_found', `${missing.length ? `No suggestion ${missing.join(', ')} waits` : 'No suggestion matches'} in this draft. suggestions_list shows what waits`);
      }
      const ids = picked.map((e) => e.id);
      let resolved;
      if (ctx.source.startsWith('agent:') && !ctx.autoApprove()) {
        // Withdrawing: the agent's own suggestions the user has not edited. Anything else is the user's decision, asked on the
        // card in every permission mode (Allow all included); the card stands in for the edited-suggestion confirm.
        const touched = picked.some((e) => edited(doc, e.id));
        if (!(a.action === 'reject' && !touched && picked.every((e) => e.by === ctx.source))) {
          const n = picked.length;
          const rows = picked.slice(0, ROWS).map((e) => describe(e, schema));
          if (n > ROWS) rows.push(`and ${n - ROWS} more`);
          if (touched && a.action === 'reject') rows.push('You edited this suggestion. Rejecting it also removes your edits.');
          const title = `${a.action} ${n === 1 ? 'a suggestion' : `${n} suggestions`} in the draft "${ctx.state.draft?.title || 'Untitled draft'}"`;
          if (!(await ctx.ask(title, rows.join('\n'), { risk: 'approval' }))) fail('denied', 'The user denied the request', { reason: 'user' });
        }
        if (ed.isDestroyed) fail('stale', 'The draft was closed meanwhile; read it again');
        resolved = resolve(ed, { ids }, a.action, { by: ctx.source, draftId });
      } else {
        resolved = await ctx.actions.resolveSuggestions(ed, draftId, { ids }, a.action, { by: ctx.source });
        if (resolved === null) fail('cancelled', 'The user kept the suggestions');
      }
      return { action: a.action, resolved, waiting: entries(ed.state.doc).length };
    },
  }),
  define({
    id: 'suggestions.show',
    title: 'Show a waiting suggestion in the open draft',
    brief: 'It scrolls the change into view and makes it the active one. {} shows the next.',
    group: 'suggestions',
    risk: 'read',
    undo: 'none',
    canvas: true, // the engine's cards, not the hidden DOM editor (commands.js failedGates)
    needs: ['doc.open', 'view.editor'],
    args: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { ...CHANGE_ID, description: 'A change id from suggestions_list' },
        group: GROUP_ID,
        direction: { enum: ['next', 'previous'], description: 'From the active suggestion, in document order' },
      },
    },
    result: { type: 'object', required: ['id', 'group', 'kind', 'summary'] },
    examples: [{ args: { direction: 'next' } }, { args: { id: 's7k2a1' } }, { args: { group: 'g3m9x0' } }],
    run: async (ctx, a) => {
      const eng = engineOf(ctx, ctx.state.draft);
      if (eng) {
        const id = ctx.state.draft.id;
        const cards = await eng.freshCards(id);
        if (!cards.length) fail('not_found', 'No suggestion waits in this draft');
        let c;
        if (a.id) c = cardOf(cards, a.id) ?? fail('not_found', `No suggestion ${a.id} waits in this draft`);
        else if (a.group) c = cards.find((x) => x.g === a.group) ?? fail('not_found', `No suggestion of group ${a.group} waits in this draft`);
        else c = stepFrom(cards, eng.activeCard(id), await eng.caretOf(id), a.direction === 'previous' ? -1 : 1);
        await eng.showCard(id, c);
        return cardBrief(c);
      }
      const ed = ctx.editor;
      const list = entries(ed.state.doc);
      if (!list.length) fail('not_found', 'No suggestion waits in this draft');
      let e;
      if (a.id) e = list.find((x) => x.id === a.id) ?? fail('not_found', `No suggestion ${a.id} waits in this draft`);
      else if (a.group) e = list.find((x) => x.g === a.group) ?? fail('not_found', `No suggestion of group ${a.group} waits in this draft`);
      else {
        const k = list.findIndex((x) => x.id === activeOf(ed.state));
        const step = a.direction === 'previous' ? -1 : 1;
        e = list[k < 0 ? (step > 0 ? 0 : list.length - 1) : (k + step + list.length) % list.length];
      }
      setActive(ed, e.id);
      scrollToBlock(ed, blockPos(ed.state.doc, e) ?? 0);
      return brief(ed.state.doc, ed.schema, e);
    },
  }),
  define({
    id: 'suggestions.group',
    title: 'Start a new group of suggestions with a note of the user\'s request',
    brief: 'Call it before you edit, so the user reviews your changes under their request.',
    group: 'suggestions',
    risk: 'read',
    undo: 'none',
    args: {
      type: 'object', required: ['note'], additionalProperties: false,
      properties: { note: { type: 'string', minLength: 1, maxLength: 140, pattern: '\\S', description: "A short note of the user's request" } },
    },
    result: { type: 'object', required: ['group', 'note'] },
    examples: [{ args: { note: 'Tighten the intro' } }],
    run: (ctx, a) => ({ group: ctx.startGroup(a.note.trim()), note: a.note.trim() }),
  }),
];
