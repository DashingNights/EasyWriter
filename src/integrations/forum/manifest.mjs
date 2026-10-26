// The forum integration's manifest (docs/plans/integrations.md Registry): what Settings > Integrations shows, the settings,
// project and draft keys it owns, and its settings migration. Pure: main.js (getSettings), node tests and the renderer read
// it. It imports only ./topic.mjs, never index.mjs or the gates, so no ESM cycle forms.
import { hasForum, siteOf, topicOf } from './topic.mjs';

// forumMedia: the ids of imported drafts that still hold picture or video placeholders (forum/actions.js downloadMedia).
const defaults = { forumUrl: '', forumWidth: 1454, forumMedia: [] };

/** The forum post format (src/formats.mjs), with the forum switch on or off: the core page width (forumWidth is a legacy key,
 * kept for older builds) and the titled box, whose HTML is Invision's ipsRichTextBox. default: true only makes it the format of
 * a draft without format (every draft from before format was written), never the format a new draft picks. 1454 is formats.mjs
 * DEFAULT_PAGE_WIDTH, which this file cannot import (formats.mjs imports it). */
const FORUM_POST = { id: 'forum-post', label: 'Forum post', default: true, version: 1, width: (s) => s?.pageWidth ?? 1454, padding: 22, blocks: ['box'] };

const gate = (subject, test, message, fix) => ({ subject, test, message, fix });

export default {
  id: 'forum',
  name: 'Invision Community forum',
  description: "Link projects to threads of an Invision Community forum and fill a thread's reply box with a draft. You press Submit on the forum yourself.",
  permissions: [
    'Opens the forum site in its own window, which keeps your sign-in',
    'Reads the title and breadcrumb of linked topic pages',
    'Reads your own posts in linked threads and their pictures when you import them',
    'Types the draft into the reply box of a linked thread when you push',
  ],
  // Never pruned: an off integration's keys are only hidden (constraint 3).
  owns: { settings: ['forumUrl', 'forumWidth', 'forumMedia'], project: ['thread', 'subject', 'year', 'forum'], draft: ['pushedAt'] },
  defaults,
  formats: [FORUM_POST],
  // Gates of app/gates.mjs (its subjects), listed there only while the forum is on (index.mjs integrationGates). The draft
  // subject is {id, format, threadUrl, pushedAt, threads (settings.threads)}.
  gates: {
    'draft.hasThread': gate('draft', (d) => !!topicOf(d?.threads, d?.threadUrl), "The draft's project has no forum thread",
      "Put the draft in a project with a forum thread (drafts.setThread, or Move to... on its sidebar row), or link one to its project (the link button on its row)"),
    'draft.unpushed': gate('draft', (d) => !!d && d.pushedAt == null, 'The draft is already marked as pushed', 'Unpush it first'),
    'draft.pushed': gate('draft', (d) => d?.pushedAt != null, 'The draft is not marked as pushed', 'Nothing to unpush; push it instead'),
    // A forum is in use (topic.mjs hasForum: the forum on, a forum site and a project linking one of its threads): sign-in,
    // push, the forum window.
    'app.forum': gate('settings', hasForum, 'No project links a forum thread', 'Link a forum thread to a project'),
  },
  // Plan step 9: switching the forum off hides its services, never a forum draft's own controls. With it off, the open draft of a
  // project with a forum thread keeps the `wakes` slots (its row's Pushed tick, Push to forum or Unpush) and the palette's Push
  // to forum, and using one asks to turn the forum back on. `wake` is that draft test on the gates' draft subject (index.mjs:
  // gate wake.forum, never hidden while off). DraftMenuItems: the same Push to forum or Unpush in the row's right-click menu.
  wake: gate('draft', (d) => !!topicOf(d?.threads, d?.threadUrl), "The open draft's project has no forum thread", 'Open a draft of a project with a forum thread'),
  wakes: ['DraftRowBadge', 'DraftRowActions', 'DraftMenuItems'],
  turnOn: 'The user turns it on in Settings > Integrations, or from Push to forum on a draft of a project with a forum thread',
  // formats.mjs defaultFormat while the forum is on: a new draft in a project linking a forum thread is a forum post.
  prefers: (settings, threadUrl) => (topicOf(settings?.threads, threadUrl) ? 'forum-post' : null),
  // The assistant's situation note adds it after the open draft's project while the forum is on (index.mjs situationNotes).
  situation: (draft, settings) => (topicOf(settings?.threads, draft?.threadUrl) ? ', linked to a forum thread' : ''),
  // Appended to the MCP instructions while the forum is on (agent-server.js).
  agentNote: ' A forum post (format forum-post) takes the forum keys of doc_format instead. Pushes to the forum ask the user, and '
    + 'the user presses Submit on the forum.',

  /** settings.json's `stored` object as read, on every read and whether the forum is on or not. Threads with no forum site
   * (from before the site was a setting) get the site of the first one. A profile from before integrations gets the forum on
   * when it has a site or any linked topic (legacy topic-URL keys count), off otherwise. The core page width starts at the
   * forum width, so the page and whiteboard conversion keep their width in either state after the upgrade. Nothing is written
   * here. */
  migrate(stored) {
    const topics = (stored.threads ?? []).map((t) => topicOf(stored.threads, t.url)).filter(Boolean);
    let s = stored;
    if (!s.forumUrl && topics.length) s = { ...s, forumUrl: siteOf(topics[0]) };
    if (s.pageWidth === undefined && Number.isInteger(s.forumWidth)) s = { ...s, pageWidth: s.forumWidth };
    if (s.integrations?.forum === undefined) s = { ...s, integrations: { ...s.integrations, forum: { enabled: !!s.forumUrl || topics.length > 0 } } };
    return s;
  },
};
