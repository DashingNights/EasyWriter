import { Check, Copy } from 'lucide-react';
import { lexer } from 'marked';
import { useState } from 'react';
import { cn } from 'cn';

// The assistant's replies as Markdown (SPEC §7i Messages, 2026-10-07): marked's lexer (already installed with @tiptap/markdown)
// turns the text into tokens, rendered here as React elements, so no HTML string is ever injected. Raw HTML in a reply shows as
// text. Links open in the browser (main.js setWindowOpenHandler). Code blocks have a Copy button; no syntax colours.

/** A fenced or indented code block with its language and a Copy button (the user's click writes the clipboard). */
function CodeBlock({ text, lang }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard.writeText(text).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, () => {});
  return (
    <div data-code-block className="group relative rounded-md border bg-muted/60">
      <div className="flex h-6 items-center justify-between pr-1 pl-2 text-xs text-muted-foreground select-none">
        <span>{lang || 'code'}</span>
        <button type="button" aria-label="Copy code" onMouseDown={(e) => e.preventDefault()} onClick={copy}
          className="flex size-5 items-center justify-center rounded hover:bg-accent hover:text-accent-foreground">
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </div>
      <pre className="overflow-x-auto px-2 pb-2 font-mono text-xs leading-5 whitespace-pre"><code>{text}</code></pre>
    </div>
  );
}

/** Inline tokens (strong, em, codespan, links, line breaks, text) as React nodes. */
function inline(tokens = [], key = 'i') {
  return tokens.map((t, i) => {
    const k = `${key}.${i}`;
    switch (t.type) {
      case 'strong': return <strong key={k} className="font-semibold">{inline(t.tokens, k)}</strong>;
      case 'em': return <em key={k}>{inline(t.tokens, k)}</em>;
      case 'del': return <del key={k}>{inline(t.tokens, k)}</del>;
      case 'codespan': return <code key={k} className="rounded bg-muted px-1 py-px font-mono text-[0.85em]">{unescape(t.text)}</code>;
      case 'br': return <br key={k} />;
      case 'link':
        return /^https?:\/\//i.test(t.href)
          ? <a key={k} href={t.href} target="_blank" rel="noreferrer" title={t.href} className="text-primary underline underline-offset-2">{inline(t.tokens, k)}</a>
          : <span key={k}>{inline(t.tokens, k)}</span>;
      case 'image': return <span key={k}>{t.text || t.href}</span>;
      case 'text': return t.tokens ? <span key={k}>{inline(t.tokens, k)}</span> : unescape(t.text);
      default: return unescape(t.raw ?? t.text ?? ''); // escape, html and anything else as its text
    }
  });
}

// marked keeps HTML entities in inline text (&amp;, &lt;, &#39;); React escapes on its own, so they go back to characters.
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const unescape = (s) => String(s).replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m]);

/** Block tokens as React nodes. */
function blocks(tokens = [], key = 'b') {
  return tokens.map((t, i) => {
    const k = `${key}.${i}`;
    switch (t.type) {
      case 'space': case 'def': return null;
      case 'paragraph': return <p key={k}>{inline(t.tokens, k)}</p>;
      case 'heading': {
        const H = `h${Math.min(6, Math.max(1, t.depth))}`;
        return <H key={k} className={cn('font-semibold', t.depth <= 2 ? 'text-base' : 'text-sm')}>{inline(t.tokens, k)}</H>;
      }
      case 'code': return <CodeBlock key={k} text={t.text} lang={t.lang} />;
      case 'blockquote': return <blockquote key={k} className="grid gap-1.5 border-l-2 pl-2 text-muted-foreground">{blocks(t.tokens, k)}</blockquote>;
      case 'hr': return <hr key={k} className="border-border" />;
      case 'list': {
        const L = t.ordered ? 'ol' : 'ul';
        return (
          <L key={k} start={t.ordered && t.start !== 1 ? t.start : undefined} className={cn('grid gap-0.5 pl-5', t.ordered ? 'list-decimal' : 'list-disc')}>
            {t.items.map((it, j) => (
              <li key={`${k}.${j}`} className={cn(it.task && 'list-none -ml-5')}>
                {it.task && <input type="checkbox" checked={!!it.checked} readOnly disabled className="mr-1.5 align-middle" />}
                {it.loose ? <div className="grid gap-1.5">{blocks(it.tokens, `${k}.${j}`)}</div> : tight(it.tokens, `${k}.${j}`)}
              </li>
            ))}
          </L>
        );
      }
      case 'table':
        return (
          <div key={k} className="overflow-x-auto">
            <table className="text-xs">
              <thead><tr>{t.header.map((c, j) => <th key={j} className="border px-1.5 py-0.5 text-left font-semibold" style={{ textAlign: t.align[j] ?? undefined }}>{inline(c.tokens, `${k}.h${j}`)}</th>)}</tr></thead>
              <tbody>{t.rows.map((row, r) => <tr key={r}>{row.map((c, j) => <td key={j} className="border px-1.5 py-0.5" style={{ textAlign: t.align[j] ?? undefined }}>{inline(c.tokens, `${k}.${r}.${j}`)}</td>)}</tr>)}</tbody>
            </table>
          </div>
        );
      case 'text': return <p key={k}>{t.tokens ? inline(t.tokens, k) : unescape(t.text)}</p>;
      default: return <p key={k}>{t.raw}</p>; // html and anything else as its text
    }
  });
}

/** A tight list item's tokens: its text runs inline, nested lists as blocks. */
const tight = (tokens, key) => tokens.map((t, i) => (t.type === 'text' ? <span key={`${key}.${i}`}>{t.tokens ? inline(t.tokens, `${key}.${i}`) : unescape(t.text)}</span>
  : blocks([t], `${key}.${i}`)));

/** `text` as Markdown; `children` (the streaming caret) after the last block. */
export function Markdown({ text, children }) {
  let tokens;
  try {
    tokens = lexer(text ?? '', { gfm: true });
  } catch {
    return <div className="break-words whitespace-pre-wrap">{text}{children}</div>;
  }
  return (
    <div data-markdown className="grid min-w-0 gap-1.5 break-words">
      {blocks(tokens)}
      {children}
    </div>
  );
}
