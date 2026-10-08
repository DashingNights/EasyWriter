'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildPushScript, describeThreadsScript, STATUS_SCRIPT, DISCOVER_SCRIPT } = require('../src/forum-inject.js');

// ---- Minimal ProseMirror-like document: paragraphs of text / ipsAttachment leaves ----

class FakeNode {
  constructor(name, { text, attrs = {}, content } = {}) {
    this.type = { name };
    this.text = text;
    this.attrs = attrs;
    this.content = content;
  }
  get isText() { return this.type.name === 'text'; }
  get textContent() { return this.isText ? this.text : (this.content || []).map((c) => c.textContent).join(''); }
  get nodeSize() {
    if (this.isText) return this.text.length;
    if (!this.content) return 1;
    return 2 + this.content.reduce((n, c) => n + c.nodeSize, 0);
  }
  // Same contract as ProseMirror: cb(node, pos, parent); returning false skips the children.
  descendants(cb) {
    const walk = (parent, start) => {
      let pos = start;
      for (const child of [...parent.content]) {
        if (cb(child, pos, parent) !== false && child.content) walk(child, pos + 1);
        pos += child.nodeSize;
      }
    };
    walk(this, 0);
  }
}

function nodeAt(doc, target) {
  let found = null;
  doc.descendants((node, pos, parent) => {
    if (pos === target && !node.isText) found = { node, parent };
    return !found;
  });
  return found;
}

// The fake doc is a flat list of paragraphs, which is all the push script's markers need.
function paragraphAt(doc, p) {
  let pos = 0;
  for (const para of doc.content) {
    const end = pos + para.nodeSize;
    if (p > pos && p < end) return { para, pos, end };
    pos = end;
  }
  return null;
}

function fakeEditor() {
  let doc = new FakeNode('doc', { content: [] });
  const log = { dispatches: 0, focused: null, setContent: 0 };

  const insertContentAt = (range, content) => {
    const fileId = Number(content.match(/data-fileid="(\d+)"/)[1]);
    const att = new FakeNode('ipsAttachment', { attrs: { attachmentType: 'image', fileId, alignStyle: 'regular', attachmentWidth: 'automatic' } });
    const hit = paragraphAt(doc, range.from + 1);
    if (hit.pos === range.from && hit.end === range.to) {
      hit.para.content = [att]; // TipTap wraps inline content that replaces a whole paragraph
      return;
    }
    const { para, pos } = paragraphAt(doc, range.from);
    const text = para.content[0].text;
    const [a, b] = [range.from - pos - 1, range.to - pos - 1];
    para.content = [
      text.slice(0, a) && new FakeNode('text', { text: text.slice(0, a) }),
      att,
      text.slice(b) && new FakeNode('text', { text: text.slice(b) }),
    ].filter(Boolean);
  };

  const ed = {
    state: {
      get doc() {
        doc.resolve = (p) => {
          const { para, pos, end } = paragraphAt(doc, p);
          return { parent: para, before: () => pos, after: () => end };
        };
        return doc;
      },
      get tr() {
        const steps = [];
        return { steps, setNodeMarkup(pos, type, attrs) { steps.push({ pos, attrs }); return this; } };
      },
    },
    view: {
      dispatch(tr) {
        log.dispatches++;
        for (const { pos, attrs } of tr.steps) nodeAt(doc, pos).node.attrs = attrs;
      },
    },
    chain() {
      const c = { insertContentAt(range, content) { insertContentAt(range, content); return c; }, run: () => true };
      return c;
    },
    commands: {
      setContent(html) {
        log.setContent++;
        const paras = [...html.matchAll(/<p>(.*?)<\/p>/g)].map(([, inner]) => {
          const text = inner.replace(/<[^>]+>/g, '');
          return new FakeNode('paragraph', { content: text ? [new FakeNode('text', { text })] : [] });
        });
        doc = new FakeNode('doc', { content: paras });
        return true;
      },
      focus(where) { log.focused = where; return true; },
    },
  };
  return { ed, log };
}

// Forum uploader: answers an injectFile event with the attachment's insert HTML (or error), like IPS does.
function fakeUploader({ upload = 'ok' } = {}) {
  const files = [];
  return {
    files,
    dispatchEvent(evt) {
      files.push(evt.data.file);
      const id = 100 + files.length;
      setTimeout(() => {
        if (upload === 'fail') evt.data.data.error();
        else evt.data.data.ready(`<img data-fileid="${id}" src="//cdn/${id}.png">`, { fileID: String(id) });
      }, 20);
      return true;
    },
  };
}

function fakeDocument(ed, uploader, { collapsed = true, upload } = {}) {
  let open = !collapsed;
  const pm = { editor: ed };
  const dummy = { click() { setTimeout(() => { open = true; }, 50); } };
  const form = {
    scrolled: false,
    scrollIntoView() { this.scrolled = true; },
    querySelector(sel) {
      if (sel === '.ProseMirror') return open ? pm : null;
      if (sel === '.ipsComposeArea_dummy') return dummy;
      if (sel === '[data-ipsuploader]') return upload === 'unavailable' ? null : uploader;
      return null;
    },
  };
  const ta = { form };
  return {
    form,
    document: { querySelector: (sel) => (sel === 'textarea[data-role="contentEditor"]' ? ta : null) },
  };
}

async function runPush(payload, opts = {}) {
  const { ed, log } = fakeEditor();
  const uploader = fakeUploader(opts);
  const { document, form } = fakeDocument(ed, uploader, opts);
  // A fast clock makes the 20 s "uploader missing" wait finish in a few ticks.
  let now = 0;
  const FastDate = { now: () => (opts.fastClock ? (now += 5000) : Date.now()) };
  const context = vm.createContext({ document, setTimeout, clearTimeout, atob, File, Event, Date: FastDate });
  const result = JSON.parse(JSON.stringify(await vm.runInContext(buildPushScript(payload), context)));
  return { result, ed, files: uploader.files, log, form };
}

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');
const payload = {
  html: '<p>Intro</p><p>[[IMG:0]]</p><p>Middle</p><p>[[IMG:1]]</p><p>End</p>',
  images: [
    { name: 'whiteboard-1.png', base64: PNG_B64, width: 1454, height: 300, type: 'image/png' },
    { name: 'whiteboard-2.jpg', base64: PNG_B64, width: 1200, height: 500, type: 'image/jpeg' },
  ],
};

test('STATUS_SCRIPT, DISCOVER_SCRIPT, describe and push scripts are valid JS', () => {
  new vm.Script(STATUS_SCRIPT);
  new vm.Script(DISCOVER_SCRIPT);
  new vm.Script(describeThreadsScript(['https://daf.staffs.ac.uk/topic/1-a/']));
  new vm.Script(buildPushScript(payload));
});

test('describe reads each topic page\'s breadcrumbs and leaves out pages without them', async () => {
  const crumbs = (...names) => JSON.stringify({ '@graph': [{ '@type': 'BreadcrumbList', itemListElement: names.map((name) => ({ item: { name } })) }] });
  const pages = {
    'https://daf.staffs.ac.uk/topic/1-a/': crumbs('Home', '2025-26', 'Games Design', 'Level Design', 'Dev log'),
    'https://daf.staffs.ac.uk/topic/2-b/': crumbs('Home'), // no access: only Home
  };
  const fetch = async (url) => (url in pages ? { ok: true, text: async () => pages[url] } : { ok: false, status: 404 });
  const DOMParser = class { parseFromString(text) { return { querySelectorAll: () => [{ textContent: text }] }; } };
  const result = await vm.runInNewContext(describeThreadsScript([...Object.keys(pages), 'https://daf.staffs.ac.uk/topic/3-gone/']), { fetch, DOMParser });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { threads: [
    { url: 'https://daf.staffs.ac.uk/topic/1-a/', title: 'Dev log', subject: 'Games Design', year: '2025-26', forum: 'Level Design' },
  ] });
});

test('STATUS_SCRIPT reports logged out when ips is missing', () => {
  const status = vm.runInNewContext(STATUS_SCRIPT, { window: {}, document: { querySelectorAll: () => [] } });
  assert.deepEqual(JSON.parse(JSON.stringify(status)), { loggedIn: false, memberId: 0, name: null, profileUrl: null });
});

test('push uploads all images first, then puts each at its marker, sized in one transaction', async () => {
  const { result, ed, files, log, form } = await runPush(payload);
  assert.deepEqual(result, { ok: true, attachments: 2 });

  const atts = [];
  ed.state.doc.descendants((node) => {
    if (node.type.name === 'ipsAttachment') atts.push(node.attrs);
  });
  assert.deepEqual(atts.map((a) => [a.fileId, a.attachmentWidth, a.alignStyle]), [[101, 1454, 'block'], [102, 1200, 'block']]);
  // Markers alone in a paragraph replace the paragraph: Intro, img, Middle, img, End.
  assert.deepEqual(
    ed.state.doc.content.map((p) => p.textContent || p.content[0].type.name),
    ['Intro', 'ipsAttachment', 'Middle', 'ipsAttachment', 'End'],
  );
  assert.equal(log.dispatches, 1);
  assert.equal(log.focused, 'end');
  assert.ok(form.scrolled);

  assert.deepEqual(files.map((f) => [f.name, f.type, f.size]), [
    ['whiteboard-1.png', 'image/png', 7],
    ['whiteboard-2.jpg', 'image/jpeg', 7],
  ]);
});

test('a marker inside text is replaced in place', async () => {
  const { result, ed } = await runPush({ html: '<p>See [[IMG:0]] here</p>', images: [payload.images[0]] });
  assert.equal(result.ok, true);
  assert.deepEqual(ed.state.doc.content[0].content.map((n) => n.text ?? n.type.name), ['See ', 'ipsAttachment', ' here']);
});

test('a failed upload stops before the post is touched', async () => {
  const { result, log } = await runPush(payload, { upload: 'fail' });
  assert.deepEqual(result, { ok: false, error: 'upload failed for image 1' });
  assert.equal(log.setContent, 0);
});

test('push reports a missing uploader', async () => {
  const { result } = await runPush(payload, { upload: 'unavailable', collapsed: false, fastClock: true });
  assert.deepEqual(result, { ok: false, error: 'forum uploader unavailable' });
});
