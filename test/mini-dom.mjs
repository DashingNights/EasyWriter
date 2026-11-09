// The part of a document @tiptap/core's generateHTML needs, for node tests: its serializer walks a document, builds elements
// with attributes and style, and reads the result back as innerHTML. Installs globalThis.window and globalThis.document.
// (forum-html.test.mjs's, moved out so forum-post.test.mjs builds a DOM post's payload too.)

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const NBSP = String.fromCharCode(0xa0);
const escText = (s) => String(s).replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;')).replaceAll(NBSP, '&nbsp;');
const escAttr = (s) => String(s).replace(/[&"<>]/g, (c) => (c === '&' ? '&amp;' : c === '"' ? '&quot;' : c === '<' ? '&lt;' : '&gt;')).replaceAll(NBSP, '&nbsp;');

// CSSOM's cssText: `prop: value;` per declaration, so an inline style carries its trailing semicolon as a browser writes it.
function makeStyle() {
  const decls = new Map();
  return {
    setProperty(k, v) { decls.set(k.toLowerCase(), String(v).trim()); },
    get cssText() { return decls.size ? [...decls].map(([k, v]) => `${k}: ${v};`).join(' ') : ''; },
    set cssText(text) {
      decls.clear();
      for (const part of String(text).split(';')) {
        const at = part.indexOf(':');
        if (at > 0) decls.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim());
      }
    },
  };
}

const serialize = (n) => {
  if (n.nodeType === 3) return escText(n.data);
  const style = n.style?.cssText;
  const attrs = [...n.attrs.filter(([k]) => k !== 'style'), ...(style ? [['style', style]] : [])];
  const open = `<${n.localName}${attrs.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('')}>`;
  if (VOID.has(n.localName)) return open;
  return `${open}${n.childNodes.map(serialize).join('')}</${n.localName}>`;
};

function makeElement(tag, ns = null) {
  const el = {
    nodeType: 1,
    localName: tag,
    namespaceURI: ns,
    attrs: [],
    childNodes: [],
    style: makeStyle(),
    appendChild(child) {
      if (child.nodeType === 11) child.childNodes.splice(0).forEach((c) => this.appendChild(c));
      else this.childNodes.push(child);
      return child;
    },
    setAttribute(name, v) {
      const found = this.attrs.find((a) => a[0] === name);
      if (found) found[1] = String(v);
      else this.attrs.push([name, String(v)]);
    },
    setAttributeNS(_ns, name, v) { this.setAttribute(name, v); },
  };
  Object.defineProperty(el, 'innerHTML', { get() { return this.childNodes.map(serialize).join(''); } });
  return el;
}

export const DOCUMENT = {
  documentElement: { style: makeStyle() },
  // A module that injects its own style at load (sonner, which export.js imports) finds a place for it.
  head: makeElement('head'),
  body: makeElement('body'),
  getElementsByTagName: () => [],
  createElement: (tag) => makeElement(tag),
  createElementNS: (ns, tag) => makeElement(tag, ns),
  createTextNode: (data) => ({ nodeType: 3, data: String(data) }),
  createDocumentFragment: () => ({ nodeType: 11, childNodes: [], appendChild(child) { this.childNodes.push(child); return child; } }),
  implementation: { createHTMLDocument: () => ({ createElement: (tag) => makeElement(tag) }) },
};

globalThis.window = { document: DOCUMENT };
globalThis.document = DOCUMENT;
