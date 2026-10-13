import type { Note } from './types';
import { normalizeTag, unique } from './tags';
import { deriveTitle } from './markdown';

const DB_NAME = 'marknest';
const STORE = 'notes';

export function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function createNote(body = '', tags: string[] = [], now = Date.now()): Note {
  return { id: newId(), title: deriveTitle(body), body, tags: unique(tags.map(normalizeTag).filter(Boolean)), createdAt: now, updatedAt: now };
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

export class NoteStore {
  private constructor(private db: IDBDatabase) {}

  static open(name = DB_NAME, factory: IDBFactory = indexedDB): Promise<NoteStore> {
    return new Promise((resolve, reject) => {
      const r = factory.open(name, 1);
      r.onupgradeneeded = () => {
        const s = r.result.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      };
      r.onsuccess = () => resolve(new NoteStore(r.result));
      r.onerror = () => reject(r.error);
    });
  }

  private tx(mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(STORE, mode).objectStore(STORE);
  }

  async all(): Promise<Note[]> {
    const notes = await req(this.tx('readonly').getAll() as IDBRequest<Note[]>);
    return notes.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  get(id: string): Promise<Note | undefined> { return req(this.tx('readonly').get(id) as IDBRequest<Note | undefined>); }
  async put(note: Note): Promise<Note> { await req(this.tx('readwrite').put(note)); return note; }
  async delete(id: string): Promise<void> { await req(this.tx('readwrite').delete(id)); }
  async clear(): Promise<void> { await req(this.tx('readwrite').clear()); }
  async putMany(notes: Note[]): Promise<void> {
    const t = this.db.transaction(STORE, 'readwrite');
    const s = t.objectStore(STORE);
    notes.forEach((n) => s.put(n));
    await new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  }
  close(): void { this.db.close(); }
}

// ---------- Import / export ----------
export interface Backup { app: 'marknest'; version: 1; exportedAt: string; notes: Note[] }

export function toBackup(notes: Note[], now = new Date()): string {
  const b: Backup = { app: 'marknest', version: 1, exportedAt: now.toISOString(), notes };
  return JSON.stringify(b, null, 2);
}

function isNote(x: unknown): x is Note {
  const n = x as Note;
  return !!n && typeof n.id === 'string' && typeof n.body === 'string' && Array.isArray(n.tags)
    && n.tags.every((t) => typeof t === 'string') && typeof n.createdAt === 'number' && typeof n.updatedAt === 'number';
}

/** Parse and validate a JSON backup. Throws on invalid input. */
export function parseBackup(json: string): Note[] {
  let data: unknown;
  try { data = JSON.parse(json); } catch { throw new Error('Backup is not valid JSON'); }
  const b = data as Partial<Backup>;
  if (!b || b.app !== 'marknest' || !Array.isArray(b.notes)) throw new Error('Not a MarkNest backup file');
  const bad = b.notes.findIndex((n) => !isNote(n));
  if (bad >= 0) throw new Error(`Invalid note at index ${bad}`);
  return b.notes.map((n) => ({ ...n, title: typeof n.title === 'string' ? n.title : deriveTitle(n.body), tags: unique(n.tags.map(normalizeTag).filter(Boolean)) }));
}

/** Merge imported notes: newer updatedAt wins per id. */
export function mergeNotes(existing: Note[], incoming: Note[]): { merged: Note[]; added: number; updated: number } {
  const map = new Map(existing.map((n) => [n.id, n]));
  let added = 0, updated = 0;
  for (const n of incoming) {
    const cur = map.get(n.id);
    if (!cur) { map.set(n.id, n); added++; }
    else if (n.updatedAt > cur.updatedAt) { map.set(n.id, n); updated++; }
  }
  return { merged: [...map.values()], added, updated };
}

/** Serialize a note to markdown with YAML-ish front matter. */
export function noteToMarkdown(n: Note): string {
  const fm = ['---', `title: ${JSON.stringify(n.title)}`, `tags: [${n.tags.join(', ')}]`, `created: ${new Date(n.createdAt).toISOString()}`, `updated: ${new Date(n.updatedAt).toISOString()}`, '---', ''];
  return fm.join('\n') + n.body;
}

/** Parse a .md file (optional front matter) into a new note. */
export function markdownToNote(text: string, fallbackTitle = 'Imported', now = Date.now()): Note {
  let body = text.replace(/\r\n/g, '\n');
  let tags: string[] = [];
  let title = '';
  let created = now;
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  if (m) {
    body = body.slice(m[0].length);
    for (const line of m[1].split('\n')) {
      const [k, ...rest] = line.split(':');
      const v = rest.join(':').trim();
      if (k.trim() === 'title') { try { title = String(JSON.parse(v)); } catch { title = v; } }
      if (k.trim() === 'tags') tags = v.replace(/^\[|\]$/g, '').split(',').map(normalizeTag).filter(Boolean);
      if (k.trim() === 'created') { const d = Date.parse(v); if (!Number.isNaN(d)) created = d; }
    }
  }
  const n = createNote(body, tags, now);
  n.title = title || (body.trim() ? deriveTitle(body) : fallbackTitle);
  n.createdAt = created;
  return n;
}

export function safeFilename(title: string): string {
  return (title.replace(/[^\p{L}\p{N}\- _]+/gu, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'note') + '.md';
}
