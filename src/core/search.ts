import type { Note } from './types';
import { noteTags } from './tags';

export interface SearchQuery { terms: string[]; phrases: string[]; tags: string[]; excluded: string[] }
export interface SearchHit { note: Note; score: number }

export function tokenize(text: string): string[] {
  return text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Parse query syntax: words, "exact phrases", #tag / tag:x filters, -excluded words. */
export function parseQuery(q: string): SearchQuery {
  const res: SearchQuery = { terms: [], phrases: [], tags: [], excluded: [] };
  const rest = q.replace(/"([^"]+)"/g, (_, p: string) => { res.phrases.push(p.toLowerCase()); return ' '; });
  for (const part of rest.split(/\s+/).filter(Boolean)) {
    if (part.startsWith('#') && part.length > 1) res.tags.push(part.slice(1).toLowerCase());
    else if (part.startsWith('tag:') && part.length > 4) res.tags.push(part.slice(4).toLowerCase());
    else if (part.startsWith('-') && part.length > 1) res.excluded.push(...tokenize(part.slice(1)));
    else res.terms.push(...tokenize(part));
  }
  return res;
}

/** Inverted index with prefix matching for fast full-text search. */
export class SearchIndex {
  private postings = new Map<string, Map<string, number>>();
  private docs = new Map<string, Note>();
  private docTokens = new Map<string, string[]>();

  constructor(notes: Note[] = []) { notes.forEach((n) => this.add(n)); }

  get size(): number { return this.docs.size; }

  add(note: Note): void {
    this.remove(note.id);
    this.docs.set(note.id, note);
    const weighted = new Map<string, number>();
    for (const t of tokenize(note.title)) weighted.set(t, (weighted.get(t) ?? 0) + 3);
    for (const t of tokenize(note.body)) weighted.set(t, (weighted.get(t) ?? 0) + 1);
    for (const t of noteTags(note)) for (const tk of tokenize(t)) weighted.set(tk, (weighted.get(tk) ?? 0) + 2);
    for (const [tok, w] of weighted) {
      let p = this.postings.get(tok);
      if (!p) this.postings.set(tok, (p = new Map()));
      p.set(note.id, w);
    }
    this.docTokens.set(note.id, [...weighted.keys()]);
  }

  remove(id: string): void {
    for (const tok of this.docTokens.get(id) ?? []) {
      const p = this.postings.get(tok);
      p?.delete(id);
      if (p && !p.size) this.postings.delete(tok);
    }
    this.docTokens.delete(id);
    this.docs.delete(id);
  }

  private matchTerm(term: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const [tok, p] of this.postings) {
      if (!tok.startsWith(term)) continue;
      const factor = tok === term ? 1 : 0.5;
      for (const [id, w] of p) out.set(id, Math.max(out.get(id) ?? 0, w * factor));
    }
    return out;
  }

  search(q: string): SearchHit[] {
    const query = parseQuery(q);
    let candidates: Map<string, number> | null = null;
    for (const term of query.terms) {
      const m = this.matchTerm(term);
      if (!candidates) candidates = m;
      else {
        const next = new Map<string, number>();
        for (const [id, s] of candidates) if (m.has(id)) next.set(id, s + m.get(id)!);
        candidates = next;
      }
    }
    if (!candidates) candidates = new Map([...this.docs.keys()].map((id) => [id, 0]));
    const hits: SearchHit[] = [];
    for (const [id, score] of candidates) {
      const note = this.docs.get(id)!;
      const hay = (note.title + '\n' + note.body).toLowerCase();
      if (!query.phrases.every((p) => hay.includes(p))) continue;
      const toks = new Set(this.docTokens.get(id));
      if (query.excluded.some((e) => toks.has(e))) continue;
      const tags = noteTags(note);
      if (!query.tags.every((s) => tags.some((t) => t === s || t.startsWith(s + '/')))) continue;
      hits.push({ note, score: score + query.phrases.length * 5 + (note.pinned ? 0.1 : 0) });
    }
    return hits.sort((a, b) => b.score - a.score || b.note.updatedAt - a.note.updatedAt);
  }
}

/** Build a short snippet around the first match of any term. */
export function snippet(body: string, q: string, len = 120): string {
  const plain = body.replace(/[#*_`>[\]()!-]/g, '').replace(/\s+/g, ' ').trim();
  const { terms, phrases } = parseQuery(q);
  const lower = plain.toLowerCase();
  let idx = -1;
  for (const t of [...phrases, ...terms]) { idx = lower.indexOf(t); if (idx >= 0) break; }
  const start = Math.max(0, idx - len / 3);
  return (start > 0 ? '…' : '') + plain.slice(start, start + len) + (start + len < plain.length ? '…' : '');
}
