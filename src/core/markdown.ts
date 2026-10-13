import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { markedHighlight } from 'marked-highlight';
import { highlightCode } from './highlight';
import { linkifyWiki } from './wikilinks';

const marked = new Marked(
  markedHighlight({ langPrefix: 'hljs language-', highlight: (code, lang) => highlightCode(code, lang) }),
  { gfm: true, breaks: false },
);

const SAFE_URL = /^(?:https?:|mailto:|tel:|#|\/|\.{0,2}\/|data:image\/(?:png|gif|jpe?g|webp);base64,)/i;

let hooked = false;
function ensureHooks(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    for (const attr of ['href', 'src']) {
      const v = node.getAttribute(attr);
      if (v !== null && !SAFE_URL.test(v.trim()) && /^[a-z][a-z0-9+.-]*:/i.test(v.trim())) node.removeAttribute(attr);
    }
    if (node.tagName === 'INPUT') {
      // Only allow GFM task-list checkboxes, rendered read-only.
      if (node.getAttribute('type') !== 'checkbox') { node.remove(); return; }
      for (const a of [...node.attributes]) if (!['type', 'checked'].includes(a.name)) node.removeAttribute(a.name);
      node.setAttribute('disabled', '');
    }
    if (node.tagName === 'A' && node.getAttribute('href') && !node.getAttribute('href')!.startsWith('#')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  });
}

/** Render markdown to sanitized HTML. Safe to assign to innerHTML. */
export interface RenderOptions { noteExists?: (title: string) => boolean }

export function renderMarkdown(src: string, opts: RenderOptions = {}): string {
  ensureHooks();
  const withLinks = opts.noteExists ? linkifyWiki(src, opts.noteExists) : src;
  const raw = marked.parse(withLinks, { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style'],
    ADD_TAGS: [],
  });
}

/** Derive a title from the first heading or first non-empty line. */
export function deriveTitle(body: string): string {
  for (const line of body.split('\n')) {
    const t = line.replace(/^\s*#{1,6}\s*/, '').trim();
    if (t) return t.slice(0, 120);
  }
  return 'Untitled';
}
