// Context menus and the mini toolbar (docs/plans/word/plan.md §3 context-menu, briefs/context-menu.md). The menus themselves are
// data (menus.mjs) that DraftMenu.jsx draws through WordMenu.jsx, and the mini toolbar is MiniToolbar.jsx; this module adds the
// right-click-only commands the menus run and records the menus as delivered behaviours.
import { openPane } from '../../../app/browser.js';

const linkOf = (ctx) => ctx.target?.getAttributes('link')?.href ?? null;

/** The picture's file: {name, data, as, ext} from a data: URL, or null. */
function pictureFile(src) {
  const m = /^data:image\/([\w.+-]+)(;base64)?,(.*)$/s.exec(src ?? '');
  if (!m) return null;
  const ext = m[1] === 'svg+xml' ? 'svg' : m[1] === 'jpeg' ? 'jpg' : m[1];
  return m[2] ? { ext, data: m[3], as: 'base64' } : { ext, data: decodeURIComponent(m[3]), as: 'text' };
}

const hasLink = (ctx) => !!linkOf(ctx);

const commands = {
  'contextMenu.hyperlink.open': {
    enabled: hasLink,
    run: (ctx) => {
      const href = linkOf(ctx);
      if (!/^https?:/i.test(href ?? '')) return false; // a bookmark link waits for fields-ref's Go To
      openPane(null, href);
      return true;
    },
  },
  'contextMenu.hyperlink.copy': { enabled: hasLink, run: (ctx) => window.api.word.clipboard.write({ text: linkOf(ctx) }) },
  'contextMenu.hyperlink.remove': { enabled: hasLink, run: (ctx) => ctx.chain((c) => c.extendMarkRange('link').unsetLink()) },
  'contextMenu.picture.saveAsPicture': {
    enabled: (ctx) => !!pictureFile(ctx.obj?.node?.attrs?.src),
    run: (ctx) => {
      const f = pictureFile(ctx.obj?.node?.attrs?.src);
      if (!f) return false;
      return window.api.word.saveFile({ name: `Picture.${f.ext}`, data: f.data, as: f.as, filters: [{ name: 'Picture', extensions: [f.ext] }] });
    },
  },
};

export default {
  id: 'context-menu',
  commands,
  implements: ['contextMenu.text', 'contextMenu.spelling', 'contextMenu.lists', 'contextMenu.table', 'contextMenu.picture', 'contextMenu.hyperlink',
    'contextMenu.field', 'contextMenu.comment', 'contextMenu.revision', 'contextMenu.headings', 'contextMenu.footnote', 'contextMenu.equation',
    'contextMenu.header', 'miniToolbar.toolbar'],
};
