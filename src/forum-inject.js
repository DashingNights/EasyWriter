'use strict';
// JS source strings executed inside live daf.staffs.ac.uk pages (Invision Community 5).
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

// Async IIFE → {threads:[{url,title,subject,year,forum}]} or {error}.
const DISCOVER_SCRIPT = `(async () => {
  try {
    const status = ${STATUS_SCRIPT};
    if (!status.loggedIn) return { error: 'not-logged-in' };
    if (!status.profileUrl) return { error: 'profile link not found on forum page' };
${TOPIC_HELPERS}
    const absolute = (href, base) => {
      const u = new URL(href, base);
      u.search = '';
      u.hash = '';
      return u.href;
    };

    // 1. Topic URLs from the profile's content list (max 10 pages).
    const urls = [];
    const visited = new Set();
    let next = status.profileUrl + 'content/?type=forums_topic';
    while (next && visited.size < 10 && !visited.has(next)) {
      visited.add(next);
      const pageUrl = next;
      const doc = await fetchDoc(pageUrl);
      for (const row of doc.querySelectorAll('li.ipsData__item')) {
        const link = [...row.querySelectorAll('a[href*="/topic/"]')]
          .find((a) => a.textContent.trim() !== 'Go to first unread post');
        if (!link) continue;
        const url = absolute(link.getAttribute('href'), pageUrl);
        if (!urls.includes(url)) urls.push(url);
      }
      const nextEl = doc.querySelector('link[rel="next"], a[rel="next"]');
      const nextHref = nextEl && nextEl.getAttribute('href');
      next = nextHref ? new URL(nextHref, pageUrl).href : null;
    }

    // 2. Title, subject, year and forum from each topic page.
    return { threads: await describeTopics(urls) };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
})()`;

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
        const timer = setTimeout(() => resolve(null), 180000);
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

module.exports = { buildPushScript, describeThreadsScript, STATUS_SCRIPT, DISCOVER_SCRIPT };
