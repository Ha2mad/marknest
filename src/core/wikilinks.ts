/** Wiki-style [[Note Title]] / [[Note Title|label]] links between notes. */
export interface WikiLink { target: string; label: string }

const LINK_RE = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]/g;

export const normTitle = (t: string): string => t.trim().replace(/\s+/g, ' ').toLowerCase();

/** Remove fenced and inline code so links inside code are ignored. */
function stripCode(body: string): string {
  return body.replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length)).replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

export function extractLinks(body: string): WikiLink[] {
  const out: WikiLink[] = [];
  for (const m of stripCode(body).matchAll(LINK_RE)) out.push({ target: m[1].trim(), label: (m[2] ?? m[1]).trim() });
  return out;
}

/** Notes that link to `title` (excluding the note itself). */
export function backlinks<T extends { id: string; title: string; body: string }>(notes: T[], title: string, selfId?: string): T[] {
  const t = normTitle(title);
  return notes.filter((n) => n.id !== selfId && extractLinks(n.body).some((l) => normTitle(l.target) === t));
}

/** Rewrite links pointing to oldTitle so they point to newTitle, keeping custom labels. Code is left untouched. */
export function renameLinks(body: string, oldTitle: string, newTitle: string): string {
  const old = normTitle(oldTitle);
  if (!old || old === normTitle(newTitle)) return body;
  const masked = stripCode(body);
  let out = '';
  let last = 0;
  for (const m of masked.matchAll(LINK_RE)) {
    if (normTitle(m[1]) !== old) continue;
    const idx = m.index!;
    const label = m[2] !== undefined ? `|${body.slice(idx + 2 + m[1].length + 1, idx + m[0].length - 2)}` : '';
    out += body.slice(last, idx) + `[[${newTitle}${label}]]`;
    last = idx + m[0].length;
  }
  return out + body.slice(last);
}

/** Convert [[links]] to markdown-safe anchors before rendering. `exists` decides styling. */
export function linkifyWiki(body: string, exists: (title: string) => boolean): string {
  const masked = stripCode(body);
  let out = '';
  let last = 0;
  for (const m of masked.matchAll(LINK_RE)) {
    const idx = m.index!;
    const target = m[1].trim();
    const label = (m[2] ?? m[1]).trim();
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    out += body.slice(last, idx) + `<a href="#wiki:${encodeURIComponent(target)}" class="wikilink${exists(target) ? '' : ' missing'}">${esc(label)}</a>`;
    last = idx + m[0].length;
  }
  return out + body.slice(last);
}

/** If the caret is inside an unfinished "[[query", return the query and its start offset. */
export function autocompleteQuery(textBeforeCaret: string): { query: string; start: number } | null {
  const m = /\[\[([^[\]|\n]*)$/.exec(textBeforeCaret);
  return m ? { query: m[1], start: m.index + 2 } : null;
}

/** Rank titles for autocomplete: prefix matches first, then substring. */
export function suggestTitles(titles: string[], query: string, limit = 8): string[] {
  const q = normTitle(query);
  const uniq = [...new Set(titles)];
  const pre = uniq.filter((t) => normTitle(t).startsWith(q));
  const sub = uniq.filter((t) => !normTitle(t).startsWith(q) && normTitle(t).includes(q));
  return [...pre.sort((a, b) => a.length - b.length), ...sub].slice(0, limit);
}
