// Headers, footers and page numbers (docs/plans/word/plan.md §3 headers-footers, briefs/headers-footers.md): the Header, Footer and
// Page Number menus and galleries, the Header & Footer contextual tab, Format Page Numbers, Alt+Shift+R, the page layer and the
// agents' page number helper. Parts live in each section's sect.hdr and sect.ftr ({default, first, even}; null links to the
// previous section); model.mjs holds the pure rules, edit.js the editing session, layer.js the drawing.
import { confirmDialog } from '../../../app/actions.js';
import { UNITS, unitOf } from '../../../tooling/kit/units.mjs';
import { deepPatch } from '../../../office.mjs';
import { geometryOf } from '../../geometry.js';
import {
  change, closeStory, currentPage, currentSection, drawnSects, HeadersFootersPlugin, hfKey, openStory, putPart, reopen, sectsOf,
  sessionOf, writeSect,
} from './edit.js';
import { headersFootersLayer } from './layer.js';
import {
  CURRENT_GALLERY, EDGE, galleryBlocks, hasPageNumbers, HF_GALLERY, isLinked, MARGIN_GALLERY, marginNumberBox, NUMBER_GALLERY,
  numberBlocks, pageXofY, partOf, partsInOrder, previousContent, resolvePart, setPageNumberPart, STYLE,
} from './model.mjs';
import { PageNumberFormat } from './PageNumberFormat.jsx';
import { both } from '../../../tooling/engine-provider.mjs';

export { setPageNumberPart } from './model.mjs';

/** The page `ed`'s commands act on, as a PageBox (null before the first layout). */
const pageNow = (ed) => geometryOf(ed.state)?.pages[currentPage(ed)] ?? null;

/** Writes `blocks` as `kind`'s part of the current page, one undo step, and opens that part for editing (Word's gallery picks). */
function insertPart(ed, kind, blocks) {
  const page = ed && pageNow(ed);
  if (!page || !blocks) return false;
  closeStory({ focus: false });
  change(ed, (tr) => putPart(tr, page.section, EDGE[kind], partOf(page.part), blocks));
  return openStory(ed, { kind, page: page.index });
}

/** Remove Header or Remove Footer: the current page's part becomes empty in the section holding it, so the sections linked to it too. */
function removePart(ed, kind) {
  const page = ed && pageNow(ed);
  if (!page) return false;
  const edge = EDGE[kind];
  const part = partOf(page.part);
  const open = sessionOf();
  closeStory({ focus: !open });
  change(ed, (tr) => {
    const holder = resolvePart(sectsOf(tr.doc), page.section, edge, part).holder;
    if (holder != null) writeSect(tr, holder, (old) => ({ ...old, [edge]: { ...(old[edge] ?? {}), [part]: [] } }));
  });
  if (open) openStory(ed, { kind: open.kind, page: open.page, select: null });
  return true;
}

/** The page numbers the current page shows: {label, pages}, as text for the stored results of new fields. */
function numbersNow(ed) {
  const geo = geometryOf(ed.state);
  return { label: geo?.pages[currentPage(ed)]?.label ?? '1', pages: String(geo?.pages.length ?? 1) };
}

/** A Page Number gallery's command over its items: `put(ctx, id)` → blocks or a result. Unknown ids (another package's user block) decline. */
const numberCommand = (kind, items) => ({
  run: (ctx, id) => {
    if (!items.some((i) => i.id === id) || !ctx.ed) return false;
    const { label, pages } = numbersNow(ctx.ed);
    return insertPart(ctx.ed, kind, numberBlocks(EDGE[kind], id, label, pages));
  },
});

/** The session's toggle or command: enabled only while a header or footer is edited. */
const inHeader = (ctx) => !!ctx.in.header && !!sessionOf();

/** A Position spinner: the current section's margin `key` in points, its More part further from the edge, Less closer. */
function position(id, key) {
  const get = (ctx) => (ctx.ed ? sectsOf(ctx.ed.state.doc)[currentSection(ctx.ed)]?.margin?.[key] ?? 0 : 0);
  const set = (ctx, pt) => {
    const v = Number(pt);
    if (!ctx.ed || !Number.isFinite(v)) return false;
    const section = currentSection(ctx.ed);
    const done = change(ctx.ed, (tr) => writeSect(tr, section, (old) => deepPatch(old, { margin: { [key]: Math.min(1584, Math.max(0, v)) } })));
    reopen(ctx.ed);
    return done;
  };
  // One step is a tenth of the shown unit, as the spinner arrows step.
  const step = (ctx) => UNITS[unitOf(ctx.settings, ctx.profile, globalThis.navigator?.language)] / 10;
  return {
    [id]: { value: get, run: set, enabled: (ctx) => !!ctx.ed },
    [`${id}.more`]: { run: (ctx) => set(ctx, get(ctx) + step(ctx)), enabled: (ctx) => !!ctx.ed },
    [`${id}.less`]: { run: (ctx) => set(ctx, get(ctx) - step(ctx)), enabled: (ctx) => !!ctx.ed },
  };
}

/** Previous (-1) or Next (+1): the part of the neighbouring section or page kind, in page order. */
function stepPart(ctx, dir) {
  const s = sessionOf();
  const pages = s && geometryOf(s.ed.state)?.pages;
  if (!pages) return null;
  const list = partsInOrder(pages);
  const i = list.findIndex((x) => x.section === s.section && x.part === s.part);
  return i < 0 ? null : list[i + dir] ?? null;
}

/** Opens the part at `arg` {section, part, from, to} for x.reveal.header and x.reveal.footer: its first page showing it. */
function reveal(kind) {
  return {
    run: (ctx, arg) => {
      const pages = ctx.ed && geometryOf(ctx.ed.state)?.pages;
      if (!pages || !arg) return false;
      const page = pages.find((p) => p.section === arg.section && partOf(p.part) === (arg.part ?? 'default')) ?? pages.find((p) => p.section === arg.section);
      if (!page) return false;
      return openStory(ctx.ed, { kind, page: page.index, select: arg.from != null ? { from: arg.from, to: arg.to ?? arg.from } : null });
    },
  };
}

/** Sets the current section's page number {at, align, start} or null (Word's v1 page number as a part): x.headersFooters.pageNumber. */
function setPageNumber(ctx, value) {
  if (!ctx.ed) return false;
  const section = currentSection(ctx.ed);
  closeStory({ focus: false });
  return change(ctx.ed, (tr) => writeSect(tr, section, (old) => setPageNumberPart(old, value ?? null)));
}

const COMMANDS = {
  // Insert > Header and Footer, and the same menus on the Header & Footer tab
  'insert.headerFooter.header': { run: (ctx, id) => insertPart(ctx.ed, 'header', galleryBlocks('hdr', id)) },
  'insert.headerFooter.footer': { run: (ctx, id) => insertPart(ctx.ed, 'footer', galleryBlocks('ftr', id)) },
  'insert.headerFooter.header.editHeader': { run: (ctx) => openStory(ctx.ed, { kind: 'header' }) },
  'insert.headerFooter.footer.editFooter': { run: (ctx) => openStory(ctx.ed, { kind: 'footer' }) },
  'insert.headerFooter.header.removeHeader': { run: (ctx) => removePart(ctx.ed, 'header') },
  'insert.headerFooter.footer.removeFooter': { run: (ctx) => removePart(ctx.ed, 'footer') },

  // Page Number
  'insert.headerFooter.pageNumber': { run: (ctx, arg) => (arg && typeof arg === 'object' ? setPageNumber(ctx, arg) : false) },
  'insert.headerFooter.pageNumber.topOfPage': numberCommand('header', NUMBER_GALLERY),
  'insert.headerFooter.pageNumber.bottomOfPage': numberCommand('footer', NUMBER_GALLERY),
  'insert.headerFooter.pageNumber.pageMargins': {
    run: (ctx, id) => {
      if (!MARGIN_GALLERY.some((i) => i.id === id) || !ctx.ed) return false;
      const page = pageNow(ctx.ed);
      if (!page) return false;
      const own = resolvePart(drawnSects(ctx.ed.state.doc), page.section, 'hdr', partOf(page.part)).content ?? [];
      return insertPart(ctx.ed, 'header', [...own, marginNumberBox(id, numbersNow(ctx.ed).label)]);
    },
  },
  'insert.headerFooter.pageNumber.currentPosition': {
    // At the caret of whatever story is the target: the body, a header, a footer, a note.
    run: (ctx, id) => {
      if (!ctx.ed || !CURRENT_GALLERY.some((i) => i.id === id)) return false;
      const { label, pages } = numbersNow(ctx.ed);
      const content = id === 'pageXofY' ? pageXofY(label, pages) : [{ type: 'field', attrs: { code: 'PAGE', result: label } }];
      return ctx.chain((c) => c.insertContent(content));
    },
  },
  'insert.headerFooter.pageNumber.formatPageNumbers': {
    run: async (ctx) => {
      const ed = ctx.ed;
      if (!ed) return false;
      const section = currentSection(ed);
      const result = await ctx.dialog('pageNumberFormat', { value: sectsOf(ed.state.doc)[section]?.pgNum });
      if (!result || ed.isDestroyed) return false;
      return change(ed, (tr) => writeSect(tr, section, (old) => ({ ...old, pgNum: { ...(old.pgNum ?? {}), ...result } })));
    },
  },
  'insert.headerFooter.pageNumber.removePageNumbers': {
    run: (ctx) => {
      if (!ctx.ed) return false;
      const open = sessionOf();
      closeStory({ focus: !open });
      const done = change(ctx.ed, (tr) => sectsOf(tr.doc).forEach((_, i) => writeSect(tr, i, (old) => setPageNumberPart(old, null))));
      if (open) openStory(ctx.ed, { kind: open.kind, page: open.page, select: null });
      return done;
    },
    enabled: (ctx) => !!ctx.ed && drawnSects(ctx.ed.state.doc).some(hasPageNumbers),
    reason: () => 'There are no page numbers to remove.',
  },

  // Header & Footer tab: Navigation
  'headerFooter.navigation.goToHeader': {
    run: (ctx) => openStory(ctx.ed, { kind: 'header', page: sessionOf().page, select: null }),
    enabled: (ctx) => inHeader(ctx) && sessionOf().kind === 'footer',
  },
  'headerFooter.navigation.goToFooter': {
    run: (ctx) => openStory(ctx.ed, { kind: 'footer', page: sessionOf().page, select: null }),
    enabled: (ctx) => inHeader(ctx) && sessionOf().kind === 'header',
  },
  'headerFooter.navigation.previous': {
    run: (ctx) => openStory(ctx.ed, { kind: sessionOf().kind, page: stepPart(ctx, -1).page, select: null }),
    enabled: (ctx) => inHeader(ctx) && !!stepPart(ctx, -1),
  },
  'headerFooter.navigation.next': {
    run: (ctx) => openStory(ctx.ed, { kind: sessionOf().kind, page: stepPart(ctx, 1).page, select: null }),
    enabled: (ctx) => inHeader(ctx) && !!stepPart(ctx, 1),
  },
  'headerFooter.navigation.linkToPrevious': {
    active: (ctx) => {
      const s = sessionOf();
      return !!s && !!ctx.ed && isLinked(drawnSects(ctx.ed.state.doc), s.section, s.edge, s.part);
    },
    enabled: (ctx) => inHeader(ctx) && sessionOf().section > 0,
    reason: () => 'The first section has no previous section to link to.',
    run: async (ctx) => {
      const s = sessionOf();
      const ed = ctx.ed;
      const sects = drawnSects(ed.state.doc);
      if (isLinked(sects, s.section, s.edge, s.part)) {
        // Off: the section keeps a copy of what it showed (Word's).
        const content = previousContent(sects, s.section, s.edge, s.part);
        closeStory({ focus: false });
        change(ed, (tr) => writeSect(tr, s.section, (old) => ({ ...old, [s.edge]: { ...(old[s.edge] ?? {}), [s.part]: content } })));
      } else {
        const own = sects[s.section]?.[s.edge]?.[s.part] ?? [];
        const kind = s.kind === 'header' ? 'header' : 'footer';
        const hasText = JSON.stringify(own).includes('"text"') || JSON.stringify(own).includes('"field"');
        if (hasText && !(await confirmDialog({
          title: `Link this ${kind} to the previous section?`,
          description: `This section's own ${kind} is deleted and the previous section's ${kind} shows instead.`,
          confirmText: 'Link', destructive: true,
        }))) return false;
        closeStory({ focus: false });
        change(ed, (tr) => writeSect(tr, s.section, (old) => {
          const parts = { ...(old[s.edge] ?? {}) };
          delete parts[s.part];
          return { ...old, [s.edge]: parts };
        }));
      }
      return openStory(ed, { kind: s.kind, page: s.page, select: null });
    },
  },

  // Options
  'headerFooter.options.differentFirstPage': {
    active: (ctx) => !!ctx.ed && !!sectsOf(ctx.ed.state.doc)[currentSection(ctx.ed)]?.titlePg,
    enabled: (ctx) => !!ctx.ed,
    run: (ctx) => {
      const section = currentSection(ctx.ed);
      const on = !sectsOf(ctx.ed.state.doc)[section]?.titlePg;
      const done = change(ctx.ed, (tr) => writeSect(tr, section, (old) => ({ ...old, titlePg: on })));
      reopen(ctx.ed);
      return done;
    },
  },
  'headerFooter.options.differentOddEvenPages': {
    active: (ctx) => !!ctx.ed?.state.doc.attrs.settings?.evenAndOddHeaders,
    enabled: (ctx) => !!ctx.ed,
    run: (ctx) => {
      const on = !ctx.ed.state.doc.attrs.settings?.evenAndOddHeaders;
      // setDocSettings's step, inline so it shares change()'s undo step with the v1 conversion.
      const done = change(ctx.ed, (tr) => tr.setDocAttribute('settings', deepPatch(tr.doc.attrs.settings ?? {}, { evenAndOddHeaders: on })));
      reopen(ctx.ed);
      return done;
    },
  },
  'headerFooter.options.showDocumentText': {
    active: (ctx) => !!ctx.ed && hfKey.getState(ctx.ed.state)?.showBody !== false,
    enabled: inHeader,
    run: (ctx) => {
      const show = hfKey.getState(ctx.ed.state)?.showBody !== false;
      ctx.ed.view.dispatch(ctx.ed.state.tr.setMeta(hfKey, { showBody: !show }).setMeta('addToHistory', false));
      return true;
    },
  },

  // Position
  ...position('headerFooter.position.headerPositionFromTop', 'header'),
  ...position('headerFooter.position.footerPositionFromBottom', 'footer'),

  // Close, keys and the cross-package commands
  'headerFooter.close.closeHeaderAndFooter': { run: () => closeStory(), enabled: inHeader },
  'headersFooters.copyPrevious': {
    enabled: (ctx) => inHeader(ctx) && sessionOf().section > 0,
    run: (ctx) => {
      const s = sessionOf();
      const content = previousContent(drawnSects(ctx.ed.state.doc), s.section, s.edge, s.part);
      // Through the story editor, so the copy is an edit batch like typing and its own story undo step.
      return s.story.editor.commands.setContent(content.length ? content : [{ type: 'paragraph', attrs: { styleId: STYLE[s.edge] } }]);
    },
  },
  'x.headersFooters.pageNumber': { run: setPageNumber },
  'x.reveal.header': reveal('header'),
  'x.reveal.footer': reveal('footer'),
};

// Word lists Page X of Y under its own heading.
const numberItems = () => NUMBER_GALLERY.map((i) => ({ ...i, group: i.id === 'pageXofY' ? 'Page X of Y' : 'Simple' }));

// The items read nothing from the document, so they serve a canvas draft too (`engine`).
const GALLERIES = {
  'insert.headerFooter.header': both(() => HF_GALLERY.map((i) => ({ ...i, group: 'Built-in' }))),
  'insert.headerFooter.footer': both(() => HF_GALLERY.map((i) => ({ ...i, group: 'Built-in' }))),
  'insert.headerFooter.pageNumber.topOfPage': both(() => numberItems()),
  'insert.headerFooter.pageNumber.bottomOfPage': both(() => numberItems()),
  'insert.headerFooter.pageNumber.pageMargins': both(() => MARGIN_GALLERY.map((i) => ({ ...i, group: 'Simple' }))),
  'insert.headerFooter.pageNumber.currentPosition': both(() => CURRENT_GALLERY.map((i) => ({ ...i, group: 'Simple' }))),
};

export default {
  id: 'headers-footers',
  extensions: [HeadersFootersPlugin],
  commands: COMMANDS,
  galleries: GALLERIES,
  dialogs: { pageNumberFormat: PageNumberFormat },
  layers: [headersFootersLayer],
  implements: ['headersFooters.doubleClick', 'headersFooters.labels', 'headersFooters.growsBody', 'headersFooters.styles', 'headersFooters.contextMenu'],
  setup: () => () => closeStory({ focus: false }),
};
