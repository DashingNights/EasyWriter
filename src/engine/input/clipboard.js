// Copy, cut and paste in the canvas editor (briefs/engine-input.md). Copy and cut run the engine's own Copy and Cut, which keep the
// copy in the engine and answer its text, HTML and RTF (the worker adds the RTF, and marks the HTML with a token naming the
// draft's session, so a paste in another draft of the window takes the copy itself: viewport-design.md section 8); those go to
// a writer: the host's (the app's clipboard bridge, which takes RTF), else the browser clipboard, which takes the text and HTML
// only. Paste reads the paste event's data: a .docx file goes to the engine as one (paste('docx', bytes)); anything else goes
// to the engine's Paste with every format at once, so it picks its own copy while the clipboard still holds that text
// (lossless), else the HTML, else the RTF, else the text.

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Functions that hear each copy or cut's {text, html} (the app's Clipboard pane joins them: src/document/wp/clipboard). */
export const afterCopy = new Set();

/** The browser's clipboard as a writer: text and HTML (a page cannot write RTF, so `rtf` is left out). */
export const webClipboard = {
  write: ({ text, html }) => navigator.clipboard.write([new ClipboardItem({
    'text/plain': new Blob([text], { type: 'text/plain' }),
    'text/html': new Blob([html], { type: 'text/html' }),
  })]),
};

/** What DataTransfer `dt` holds → {text, html, rtf, docx (a File or null), files (every file)}. */
export const readTransfer = (dt) => ({
  text: dt?.getData('text/plain') ?? '',
  html: dt?.getData('text/html') ?? '',
  rtf: dt?.getData('text/rtf') ?? '',
  docx: [...(dt?.files ?? [])].find((f) => f.type === DOCX || /\.docx$/i.test(f.name)) ?? null,
  files: [...(dt?.files ?? [])],
});

/** Whether pasted `html` carries content of its own: text, or an object a post keeps. An image pasted from another program
 * comes with a bitmap beside an HTML `<img>` alone, and that goes as a file instead (as whiteboard.js WhiteboardPaste tells
 * them apart). */
function richHtml(html) {
  if (!html) return false;
  if (/data-(canvas|plan-chart|media|whiteboard|ew-media)\b/.test(html)) return true;
  return new DOMParser().parseFromString(html, 'text/html').body.textContent.trim() !== '';
}

/** Clipboard handling on page area `el` → {copy, cut, paste(data, textOnly), off}. Paste Text Only's key runs its row through
 * the tool registry, which reads the clipboard itself (src/document/canvas/rows/home.mjs). `pasteHtml(html)` and
 * `pasteFiles(files)` are the host's own paste for a draft whose content is not the engine's (a forum post: post.js filters
 * the HTML to the kit and makes pictures and media; viewport-design.md section 8). Both are left out for a Document. */
export function clipboardOf({ el, client, run, changed, writer, pasteHtml, pasteFiles }) {
  // Cut through the engine's own command: its tracked cut can become a move when pasted, and a whole table selected goes, as in Word.
  async function copy(cut = false) {
    const r = await client.exec(cut ? 'edit.cut' : 'edit.copy');
    const { text = '', html = '', rtf = '' } = (r?.ok && r.value) || {};
    if (!text && !html) return false; // a caret copies nothing, as in Word
    await writer.write(rtf ? { text, html, rtf } : { text, html });
    for (const fn of afterCopy) fn({ text, html });
    return true;
  }
  const cut = () => copy(true);
  async function paste(d, textOnly = false) {
    if (d.docx) return client.paste('docx', new Uint8Array(await d.docx.arrayBuffer()));
    if (textOnly) return d.text && client.exec('edit.pasteText', { text: d.text });
    // A copy made in another draft of this window carries the worker's token in its HTML: the copy itself pastes, nothing lost.
    const own = d.html && client.pasteFrom ? await client.pasteFrom(d.html) : null;
    if (own) return own;
    // The host's paste: its HTML is filtered to what the draft keeps, and pasted pictures and media come in as its own nodes.
    // `objects`: a copy of the post kit's own canvases, plan charts and media keeps them (a forum's HTML never asks for this).
    if (pasteHtml && richHtml(d.html)) return pasteHtml(d.html, { objects: true });
    if (pasteFiles && d.files?.length) return pasteFiles(d.files);
    if (!d.text && !d.html && !d.rtf) return null;
    return client.exec('edit.paste', { text: d.text || undefined, html: d.html || undefined, rtf: d.rtf || undefined });
  }
  // The copy event is synchronous but the engine answers later, so the write goes through the writer, never the event's data.
  const handlers = {
    copy: (e) => {
      e.preventDefault();
      run(copy);
    },
    cut: (e) => {
      e.preventDefault();
      run(cut);
      changed(true);
    },
    paste: (e) => {
      e.preventDefault();
      const d = readTransfer(e.clipboardData);
      run(() => paste(d));
      changed(true);
    },
  };
  for (const [k, fn] of Object.entries(handlers)) el.addEventListener(k, fn);
  return {
    copy,
    cut,
    paste,
    off: () => {
      for (const [k, fn] of Object.entries(handlers)) el.removeEventListener(k, fn);
    },
  };
}
