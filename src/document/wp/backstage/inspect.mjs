// The Document Inspector's checks (docs/plans/word/briefs/backstage.md Document Inspector) on a Document's TipTap JSON: what each
// category finds, and its Remove All as a pure transform that returns a new doc and keeps every doc attr it does not clear
// (codemap.md §7). Word's categories with no counterpart here (add-ins, embedded documents, macros, custom XML) are left out.
// Pure: Node tests load it.

/** The categories in Word's order: {id, label} with Word's check box labels. */
export const CATEGORIES = [
  { id: 'comments', label: 'Comments, Revisions, and Versions' },
  { id: 'props', label: 'Document Properties and Personal Information' },
  { id: 'collapsed', label: 'Collapsed Headings' },
  { id: 'headers', label: 'Headers, Footers, and Watermarks' },
  { id: 'invisible', label: 'Invisible Content' },
  { id: 'hidden', label: 'Hidden Text' },
];

const REV_MARKS = new Set(['insertion', 'deletion', 'formatChange']);
const FLOATS = new Set(['image', 'textBox', 'canvas']);
const PERSONAL = [['core', 'creator'], ['core', 'lastModifiedBy'], ['app', 'company'], ['app', 'manager']];

const isHiddenText = (n) => n.type === 'text' && n.marks?.some((m) => m.type === 'textStyle' && m.attrs?.vanish === true);
const isHiddenFloat = (n) => FLOATS.has(n.type) && n.attrs?.layout?.hidden === true;
const hasStory = (part) => !!part && Object.values(part).some(Boolean);

/** Every sect of `doc`: the sectionBreaks' and doc.attrs.sect (the last section's). */
function sectsOf(doc) {
  const out = [];
  walk(doc, (n) => n.type === 'sectionBreak' && n.attrs?.sect && out.push(n.attrs.sect));
  if (doc.attrs?.sect) out.push(doc.attrs.sect);
  return out;
}

function walk(node, fn) {
  fn(node);
  for (const c of node.content ?? []) walk(c, fn);
}

/** What `doc` holds per category → {comments, revisions, props: string[] (the personal fields set), collapsed, headers,
 * invisible, hidden}, counts except props. */
export function inspect(doc) {
  const found = { comments: 0, revisions: 0, props: [], collapsed: 0, headers: 0, invisible: 0, hidden: 0 };
  const commentIds = new Set(Object.keys(doc.attrs?.comments ?? {}));
  const revIds = new Set();
  walk(doc, (n) => {
    for (const m of n.marks ?? []) {
      if (m.type === 'comment' && m.attrs?.id) commentIds.add(m.attrs.id);
      if (REV_MARKS.has(m.type)) revIds.add(`${m.type}:${m.attrs?.id}`);
    }
    const a = n.attrs ?? {};
    if (a.markRev) revIds.add(`markRev:${JSON.stringify(a.markRev)}`);
    if (a.pChange) revIds.add(`pChange:${a.pChange.id ?? JSON.stringify(a.pChange)}`);
    if (a.rev) revIds.add(`rev:${JSON.stringify(a.rev)}`);
    if (a.collapsed === true) found.collapsed++;
    if (isHiddenFloat(n)) found.invisible++;
    if (isHiddenText(n)) found.hidden++;
  });
  found.comments = commentIds.size;
  found.revisions = revIds.size;
  const props = doc.attrs?.props ?? {};
  found.props = PERSONAL.filter(([g, k]) => props[g]?.[k]).map(([, k]) => k);
  if (doc.attrs?.people?.length) found.props.push('people');
  found.headers = sectsOf(doc).filter((s) => hasStory(s.hdr) || hasStory(s.ftr) || s.watermark).length;
  return found;
}

/** Whether category `id` found anything in `found` (inspect's result). */
export const foundIn = (found, id) => (id === 'comments' ? found.comments + found.revisions > 0 : id === 'props' ? found.props.length > 0 : found[id] > 0);

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Category `id`'s result line in our words: what was found, or that nothing was. */
/** The engine's findings (file.inspectFindings's `found`) in the form describe and foundIn read; null for none. Invisible content is
 * not read on a canvas draft. */
export const engineFindings = (f) => (f ? {
  comments: f.comments ?? 0, revisions: f.revisions ?? 0, props: f.properties ? ['author'] : [], collapsed: f.collapsed ?? 0,
  headers: f.headers ?? 0, invisible: 0, hidden: f.hiddenCount ?? 0,
} : null);

/** Each category's removals in the engine's file.inspect (`remove`). */
export const ENGINE_REMOVE = { comments: ['comments', 'revisions'], props: ['properties'], collapsed: ['collapsed'], headers: ['headers'], hidden: ['hidden'] };

export function describe(found, id) {
  switch (id) {
    case 'comments': {
      const parts = [found.comments && plural(found.comments, 'comment', 'comments'), found.revisions && plural(found.revisions, 'tracked change', 'tracked changes')].filter(Boolean);
      return parts.length ? `Found ${parts.join(' and ')}.` : 'No comments or tracked changes were found.';
    }
    case 'props':
      return found.props.length ? 'Found the author, company or reviewer names saved with this document.' : 'No personal information was found.';
    case 'collapsed':
      return found.collapsed ? `Found ${plural(found.collapsed, 'collapsed heading', 'collapsed headings')}.` : 'No collapsed headings were found.';
    case 'headers':
      return found.headers ? `Found headers, footers or watermarks in ${plural(found.headers, 'section', 'sections')}.` : 'No headers, footers or watermarks were found.';
    case 'invisible':
      return found.invisible ? `Found ${plural(found.invisible, 'hidden object', 'hidden objects')}.` : 'No invisible content was found.';
    case 'hidden':
      return found.hidden ? `Found ${plural(found.hidden, 'piece', 'pieces')} of hidden text.` : 'No hidden text was found.';
    default:
      return '';
  }
}

// A copy of `node` with `fn` applied to every descendant (children first); fn returns the node, a changed copy, or null to drop it.
// A block container left empty gets an empty paragraph, as its content needs one block.
function mapTree(node, fn) {
  if (!node.content) return fn(node);
  const content = node.content.map((c) => mapTree(c, fn)).filter(Boolean);
  const textblock = node.type === 'paragraph' || node.type === 'heading';
  const next = { ...node, content: content.length || textblock ? content : [{ type: 'paragraph' }] };
  if (textblock && !content.length) delete next.content;
  return fn(next);
}

const patchSect = (sect) => (sect ? { ...sect, hdr: null, ftr: null, watermark: null } : sect);

/** `doc` with category `id` removed, a new object; `doc` stays as it is. Comments: comment marks and doc.attrs.comments (tracked
 * changes are the tracking package's Accept All); props: the personal fields and doc.attrs.people; collapsed: paragraph
 * `collapsed` set null; headers: every section's hdr, ftr and watermark set null; invisible: floating objects with layout.hidden;
 * hidden: text whose textStyle has vanish. */
export function removeCategory(doc, id) {
  const attrs = { ...doc.attrs };
  let fn = (n) => n;
  if (id === 'comments') {
    attrs.comments = null;
    fn = (n) => (n.marks?.some((m) => m.type === 'comment') ? withMarks(n, n.marks.filter((m) => m.type !== 'comment')) : n);
  } else if (id === 'props') {
    const props = attrs.props ?? null;
    if (props) {
      attrs.props = { ...props };
      for (const [g, k] of PERSONAL) if (props[g]?.[k] != null) attrs.props[g] = { ...attrs.props[g], [k]: null };
    }
    attrs.people = null;
  } else if (id === 'collapsed') {
    fn = (n) => (n.attrs?.collapsed ? { ...n, attrs: { ...n.attrs, collapsed: null } } : n);
  } else if (id === 'headers') {
    attrs.sect = patchSect(attrs.sect);
    fn = (n) => (n.type === 'sectionBreak' && n.attrs?.sect ? { ...n, attrs: { ...n.attrs, sect: patchSect(n.attrs.sect) } } : n);
  } else if (id === 'invisible') {
    fn = (n) => (isHiddenFloat(n) ? null : n);
  } else if (id === 'hidden') {
    fn = (n) => (isHiddenText(n) ? null : n);
  }
  return { ...mapTree(doc, fn), attrs };
}

function withMarks(n, marks) {
  const next = { ...n, marks };
  if (!marks.length) delete next.marks;
  return next;
}
