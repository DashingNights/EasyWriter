'use strict';
// JS source strings executed inside live pages of the forum site (settings.forumUrl, an Invision Community 5 site).
// See SPEC.md §1 (forum facts) and §4.

// Expression → {loggedIn, memberId, name, profileUrl}. Safe on pages without `ips` (e.g. the SSO provider).
const STATUS_SCRIPT = `(() => {
  const ips = window.ips;
  const memberId = ips && typeof ips.getSetting === 'function' ? Number(ips.getSetting('memberID')) || 0 : 0;
  if (memberId <= 0) return { loggedIn: false, memberId: 0, name: null, profileUrl: null };
  const links = [...document.querySelectorAll('a[href*="/profile/' + memberId + '-"]')];
  let profileUrl = null;
  if (links.length) {
    const u = new URL(links[0].href);
    u.search = '';
    u.hash = '';
    profileUrl = u.href.endsWith('/') ? u.href : u.href + '/';
  }
  // Profile links read "Profile" / "Edit Profile"; the user bar's .ipsUserNav__text holds the display name.
  const navName = document.querySelector('#cUserLink .ipsUserNav__text, .ipsUserNav__text')?.textContent.trim();
  const name = ips.getSetting('memberName') || navName || null;
  return { loggedIn: true, memberId, name, profileUrl };
})()`;

// Statements shared by the thread scripts below: fetchDoc(url) → Document, and describeTopics(urls) → [{url, title, subject,
// year, forum}] from each topic page's JSON-LD breadcrumbs, 4 pages at a time. A page that does not load or has no
// breadcrumbs past Home (removed, no access) is left out.
const TOPIC_HELPERS = `
    const fetchDoc = async (url) => {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
      return new DOMParser().parseFromString(await res.text(), 'text/html');
    };
    const breadcrumbNames = (doc) => {
      for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
        let data;
        try { data = JSON.parse(script.textContent); } catch { continue; }
        const nodes = [].concat(data).flatMap((d) => (d && Array.isArray(d['@graph']) ? [d, ...d['@graph']] : [d]));
        const list = nodes.find((d) => d && d['@type'] === 'BreadcrumbList');
        if (list) return (list.itemListElement || []).map((i) => i.item?.name ?? i.name);
      }
      return [];
    };
    const describeTopics = async (urls) => {
      const threads = new Array(urls.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < urls.length) {
          const index = cursor++;
          const url = urls[index];
          let names = [];
          try { names = breadcrumbNames(await fetchDoc(url)); } catch {}
          const len = names.length;
          if (len < 2) continue;
          threads[index] = { url, title: names[len - 1], subject: names[len - 3] ?? '', year: names[1], forum: names[len - 2] };
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, urls.length) }, worker));
      return threads.filter(Boolean);
    };`;

// Async IIFE → {threads:[{url,title,subject,year,forum}]} (the topics `urls` that could be read) or {error}.
function describeThreadsScript(urls) {
  return `(async (urls) => {
  try {
${TOPIC_HELPERS}
    return { threads: await describeTopics(urls) };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
})(${JSON.stringify(urls)})`;
}

// Async IIFE → {posts: [{id, url, date (ISO or null), html, media: [{kind, src, alt}]}]}: the posts of member `memberId` on every
// page of the topic `url` (Invision pagination, /page/N/), or {error}. Invision 4 (article.cPost, .cAuthorPane) and 5
// (article.ipsEntry, .ipsEntry__author-column) both: a post is article[id^="elComment_"], its author the userid of its
// data-quotedata (else its first profile link), its body [data-role="commentContent"]. In the returned html every kept picture
// or video is an element marked data-ew-media="<index into media>" (its full-size https URL in media), an emoticon is its
// text, links are absolute, and the edit note (data-excludequote) is gone.
function postsScript(url, memberId) {
  return `(async (url, memberId) => {
  try {
${TOPIC_HELPERS}
    const topicId = (/\\/topic\\/(\\d+)/.exec(url) || [])[1];
    const base = url.replace(/[?#].*$/, '').replace(/\\/?$/, '/');
    const first = await fetchDoc(url);
    let last = 1;
    for (const el of first.querySelectorAll('[data-pages]')) last = Math.max(last, Number(el.getAttribute('data-pages')) || 1);
    for (const a of first.querySelectorAll('a[href*="/page/"], link[href*="/page/"]')) {
      const m = /\\/topic\\/(\\d+)[^?#]*\\/page\\/(\\d+)/.exec(a.getAttribute('href') || '');
      if (m && m[1] === topicId) last = Math.max(last, Number(m[2]));
    }
    last = Math.min(last, 1000);
    const docs = [first];
    let cursor = 2;
    const worker = async () => {
      while (cursor <= last) {
        const page = cursor++;
        docs[page - 1] = await fetchDoc(base + 'page/' + page + '/');
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, last - 1) }, worker));

    const IMAGE_FILE = /\\.(png|jpe?g|gif|webp|avif|bmp)(?:[?#]|$)/i;
    const abs = (v) => { try { return new URL(v, location.href).href; } catch { return ''; } };
    const authorOf = (art) => {
      for (const q of art.querySelectorAll('[data-quotedata]')) {
        if (q.closest('[data-role="commentContent"]')) continue;
        try { const d = JSON.parse(q.getAttribute('data-quotedata')); if (d && Number(d.userid)) return Number(d.userid); } catch {}
      }
      const a = art.querySelector('.cAuthorPane a[href*="/profile/"], .ipsEntry__author-column a[href*="/profile/"], aside a[href*="/profile/"], [data-role="author"] a[href*="/profile/"]')
        || art.querySelector('a[href*="/profile/"]');
      const m = a && /\\/profile\\/(\\d+)-/.exec(a.getAttribute('href') || '');
      return m ? Number(m[1]) : 0;
    };
    // The post body, cleaned for import (see above).
    const body = (content) => {
      const root = content.cloneNode(true);
      for (const x of root.querySelectorAll('[data-excludequote], script, noscript, style, template')) x.remove();
      const media = [];
      for (const img of root.querySelectorAll('img')) {
        const alt = img.getAttribute('alt') || '';
        const src = [img.getAttribute('data-src'), img.getAttribute('src')].find((v) => v && !/spacer\\.png|^data:/.test(v));
        if (img.hasAttribute('data-emoticon') || /\\/emoticons\\//.test(src || '')) { img.replaceWith(alt); continue; }
        if (!src) { img.remove(); continue; }
        const link = img.closest('a');
        // A thumbnail's full-size file: Invision 5 keeps it in data-full-image, Invision 4 in the attach link around it.
        const full = img.getAttribute('data-full-image')
          || (link && link.querySelectorAll('img').length === 1 && IMAGE_FILE.test(link.getAttribute('href') || '') ? link.getAttribute('href') : src);
        const mark = document.createElement('img');
        mark.setAttribute('data-ew-media', String(media.length));
        media.push({ kind: 'image', src: abs(full), alt });
        (link && link.textContent.trim() === '' && link.querySelectorAll('img').length === 1 ? link : img).replaceWith(mark);
      }
      for (const video of root.querySelectorAll('video')) {
        const source = video.querySelector('source');
        const src = video.getAttribute('src') || video.getAttribute('data-video-src') || (source && (source.getAttribute('src') || source.getAttribute('data-video-src')));
        if (!src) continue;
        const mark = document.createElement('img');
        mark.setAttribute('data-ew-media', String(media.length));
        media.push({ kind: 'video', src: abs(src), alt: (video.querySelector('a')?.textContent || '').trim() }); // the fallback link reads the file's name
        video.replaceWith(mark);
      }
      for (const a of root.querySelectorAll('a[href]')) a.setAttribute('href', abs(a.getAttribute('href')));
      for (const f of root.querySelectorAll('iframe')) { const s = f.getAttribute('data-embed-src') || f.getAttribute('src'); if (s) f.setAttribute('src', abs(s)); }
      return { html: root.innerHTML.trim(), media };
    };

    const posts = [];
    const seen = new Set();
    for (const doc of docs) {
      for (const art of doc.querySelectorAll('article[id^="elComment_"]')) {
        const id = art.id.slice('elComment_'.length);
        if (seen.has(id) || authorOf(art) !== memberId) continue;
        const content = art.querySelector('[data-role="commentContent"]');
        if (!content) continue;
        seen.add(id);
        const time = [...art.querySelectorAll('time[datetime]')].find((t) => !content.contains(t));
        const when = time ? new Date(time.getAttribute('datetime')) : null;
        posts.push({ id, url: base + '?do=findComment&comment=' + id, date: when && !isNaN(when) ? when.toISOString() : null, ...body(content) });
      }
    }
    return { posts };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
})(${JSON.stringify(url)}, ${Number(memberId)})`;
}

// Async IIFE that fills the topic's reply editor with payload.html and uploads payload.images
// in place of the [[IMG:i]] placeholders. Never submits the form.
function buildPushScript(payload) {
  return `(async (payload) => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (fn, timeoutMs) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const value = fn();
      if (value) return value;
      if (Date.now() >= end) return null;
      await sleep(250);
    }
  };
  try {
    const ta = await waitFor(() => document.querySelector('textarea[data-role="contentEditor"]'), 15000);
    if (!ta || !ta.form) throw new Error('reply box not found on this topic page');
    const form = ta.form;
    const getEditor = () => form.querySelector('.ProseMirror')?.editor;
    let ed = getEditor();
    if (!ed) {
      const dummy = form.querySelector('.ipsComposeArea_dummy');
      if (dummy) dummy.click();
      ed = await waitFor(getEditor, 15000);
      if (!ed) throw new Error('forum editor did not open');
    }

    // 1. Upload every image through the forum's own uploader before touching the post. The uploader answers each
    //    file with its insertable HTML (ready callback). Its in-editor placeholder path is not used: it can stall on
    //    "Uploading Attachment..." even after the upload finished.
    const uploader = await waitFor(() => form.querySelector('[data-ipsuploader]'), 20000);
    if (!uploader) throw new Error('forum uploader unavailable');
    class InjectFileEvent extends Event {
      constructor(data) { super('injectFile'); this.data = data; }
    }
    const images = payload.images || [];
    const uploaded = [];
    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      const bytes = Uint8Array.from(atob(image.base64), (c) => c.charCodeAt(0));
      const file = new File([bytes], image.name, { type: image.type || 'image/png' });
      const result = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), Math.max(180000, bytes.length / 100)); // a big video: at least 100 KB/s
        uploader.dispatchEvent(new InjectFileEvent({ file, data: {
          ready: (content, info) => { clearTimeout(timer); resolve({ content, fileId: Number(info && info.fileID) }); },
          error: () => { clearTimeout(timer); resolve(null); },
        } }));
      });
      if (!result || !result.content) throw new Error('upload failed for image ' + (i + 1));
      uploaded.push({ ...result, width: image.width });
    }

    // 2. Fill the post, then swap each [[IMG:i]] marker for its uploaded image.
    ed.commands.setContent(payload.html);

    const findText = (needle) => {
      let range = null;
      ed.state.doc.descendants((node, pos) => {
        if (range) return false;
        if (!node.isText) return true;
        const at = node.text.indexOf(needle);
        if (at >= 0) range = { from: pos + at, to: pos + at + needle.length };
        return false;
      });
      return range;
    };
    for (let i = 0; i < uploaded.length; i++) {
      const needle = '[[IMG:' + i + ']]';
      let range = findText(needle);
      if (!range) throw new Error('placeholder for image ' + (i + 1) + ' not found');
      // A marker alone in its paragraph replaces the whole paragraph, so no empty line is left behind.
      const $from = ed.state.doc.resolve(range.from);
      if ($from.parent.textContent === needle) range = { from: $from.before(), to: $from.after() };
      ed.chain().insertContentAt(range, uploaded[i].content).run();
    }

    // 3. Display width + block alignment, matched by file id, in one transaction.
    if (uploaded.length) {
      const widths = new Map(uploaded.map((u) => [u.fileId, u.width]));
      const tr = ed.state.tr;
      ed.state.doc.descendants((node, pos) => {
        if (node.type.name !== 'ipsAttachment') return true;
        const width = widths.get(Number(node.attrs.fileId));
        if (width) tr.setNodeMarkup(pos, null, { ...node.attrs, attachmentWidth: width, alignStyle: 'block' });
        return false;
      });
      ed.view.dispatch(tr);
    }

    form.scrollIntoView({ block: 'center' });
    ed.commands.focus('end');
    return { ok: true, attachments: uploaded.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
})(${JSON.stringify(payload)})`;
}

module.exports = { buildPushScript, describeThreadsScript, postsScript, STATUS_SCRIPT };
