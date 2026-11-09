// Save As builders (docs/plans/word/briefs/backstage.md Save As): Plain Text from the doc JSON, Web Page, Filtered around the
// editor's HTML, and the title a save falls back to. Pure: Node tests load it.

const TEXTBLOCKS = new Set(['paragraph', 'heading', 'codeBlock']);
const deleted = (n) => n.marks?.some((m) => m.type === 'deletion');

/** The text of a Document's TipTap JSON: one line per paragraph, tabs and line breaks kept, tracked deletions left out (as the
 * final display shows it). */
export function plainText(doc) {
  const lines = [];
  const inline = (n) => {
    if (n.type === 'text') return deleted(n) ? '' : n.text ?? '';
    if (n.type === 'hardBreak') return '\n';
    return (n.content ?? []).map(inline).join('');
  };
  const block = (n) => {
    if (TEXTBLOCKS.has(n.type)) lines.push(inline(n));
    else for (const c of n.content ?? []) block(c);
  };
  block(doc);
  return `${lines.join('\n')}\n`;
}

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** A Web Page, Filtered: `html` (the editor's HTML) in a plain HTML document titled `title`, with no app styles. */
export const webPage = (title, html) =>
  `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>${escape(title)}</title>\n</head>\n<body>\n${html}\n</body>\n</html>\n`;

/** The title a save uses: the typed one trimmed, else the draft's own. */
export const saveTitle = (typed, draftTitle) => String(typed ?? '').trim() || draftTitle || 'Untitled';

/** `title` made safe as a file name. */
export const fileName = (title, ext) => `${String(title).replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Untitled'}.${ext}`;
