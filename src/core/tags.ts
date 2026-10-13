const TAG_RE = /(^|\s)#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu;

/** Normalize a tag: trim, strip leading '#', lowercase. Returns '' if invalid. */
export function normalizeTag(raw: string): string {
  const t = raw.trim().replace(/^#+/, '').toLowerCase();
  return /^[\p{L}\p{N}_][\p{L}\p{N}_\-/]*$/u.test(t) ? t : '';
}

/** Parse a comma/space separated tag input into unique normalized tags. */
export function parseTagInput(input: string): string[] {
  return unique(input.split(/[,\s]+/).map(normalizeTag).filter(Boolean));
}

/** Extract inline #hashtags from markdown body, ignoring code blocks and inline code. */
export function extractInlineTags(body: string): string[] {
  const stripped = body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const out: string[] = [];
  for (const line of stripped.split('\n')) {
    if (/^\s{0,3}#{1,6}\s/.test(line)) continue; // markdown heading
    for (const m of line.matchAll(TAG_RE)) {
      const t = normalizeTag(m[2]);
      if (t) out.push(t);
    }
  }
  return unique(out);
}

export function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/** All tags for a note: explicit + inline. */
export function noteTags(note: { tags: string[]; body: string }): string[] {
  return unique([...note.tags.map(normalizeTag).filter(Boolean), ...extractInlineTags(note.body)]).sort();
}

/** Count tag usage across notes, sorted by count desc then name. */
export function tagCounts(notes: { tags: string[]; body: string }[]): { tag: string; count: number }[] {
  const map = new Map<string, number>();
  for (const n of notes) for (const t of noteTags(n)) map.set(t, (map.get(t) ?? 0) + 1);
  return [...map].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Notes having ALL selected tags (a tag also matches its nested children, e.g. "work" matches "work/client"). */
export function filterByTags<T extends { tags: string[]; body: string }>(notes: T[], selected: string[]): T[] {
  if (!selected.length) return notes;
  return notes.filter((n) => {
    const tags = noteTags(n);
    return selected.every((s) => tags.some((t) => t === s || t.startsWith(s + '/')));
  });
}
