import type { Note, Snapshot } from './types';
import { normalizeTag, unique } from './tags';
import { deriveTitle } from './markdown';

const DB_NAME = 'marknest';
export const DB_VERSION = 2;
const STORE = 'notes';
const HISTORY = 'history';

export const HISTORY_LIMIT = 50;
export const SNAPSHOT_INTERVAL = 5 * 60_000;

export function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function createNote(body = '', tags: string[] = [], now = Date.now()): Note {
  return { id: newId(), title: deriveTitle(body), body, tags: unique(tags.map(normalizeTag).filter(Boolean)), createdAt: now, updatedAt: now };
}

export function makeSnapshot(n: Note, now = Date.now()): Snapshot {
  return { id: newId(), noteId: n.id, title: n.title, body: n.body, tags: [...n.tags], savedAt: now };
}

/** Throttle rule: snapshot if forced, none exists, content changed and the last one is older than the interval. */
export function shouldSnapshot(last: Snapshot | undefined, note: Note, now = Date.now(), force = false, interval = SNAPSHOT_INTERVAL): boolean {
  if (last && last.body === note.body && last.tags.join() === note.tags.join()) return false;
  return force || !last || now - last.savedAt >= interval;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
function done(t: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
}

export class NoteStore {
  private constructor(private db: IDBDatabase) {}

  /** Opens the DB, migrating v1 (notes only) to v2 (adds history store) without touching existing notes. */
  static open(name = DB_NAME, factory: IDBFactory = indexedDB): Promise<NoteStore> {
    return new Promise((resolve, reject) => {
      const r = factory.open(name, DB_VERSION);
      r.onupgradeneeded = (e) => {
        const db = r.result;
        if (e.oldVersion < 1) db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
        if (e.oldVersion < 2) db.createObjectStore(HISTORY, { keyPath: 'id' }).createIndex('noteId', 'noteId');
      };
      r.onsuccess = () => resolve(new NoteStore(r.result));
      r.onerror = () => reject(r.error);
    });
  }

  private tx(mode: IDBTransactionMode, store = STORE): IDBObjectStore {
    return this.db.transaction(store, mode).objectStore(store);
  }

  async all(): Promise<Note[]> {
    const notes = await req(this.tx('readonly').getAll() as IDBRequest<Note[]>);
    return notes.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  get(id: string): Promise<Note | undefined> { return req(this.tx('readonly').get(id) as IDBRequest<Note | undefined>); }
  async put(note: Note): Promise<Note> { await req(this.tx('readwrite').put(note)); return note; }
  /** Deletes a note and its history. */
  async delete(id: string): Promise<void> {
    const t = this.db.transaction([STORE, HISTORY], 'readwrite');
    t.objectStore(STORE).delete(id);
    const h = t.objectStore(HISTORY);
    const keys = await req(h.index('noteId').getAllKeys(id));
    keys.forEach((k) => h.delete(k));
    await done(t);
  }
  async clear(): Promise<void> {
    const t = this.db.transaction([STORE, HISTORY], 'readwrite');
    t.objectStore(STORE).clear(); t.objectStore(HISTORY).clear();
    await done(t);
  }
  async putMany(notes: Note[], snapshots: Snapshot[] = []): Promise<void> {
    const t = this.db.transaction([STORE, HISTORY], 'readwrite');
    notes.forEach((n) => t.objectStore(STORE).put(n));
    snapshots.forEach((s) => t.objectStore(HISTORY).put(s));
    await done(t);
  }

  // ---------- history ----------
  /** Snapshots for a note, newest first. */
  async history(noteId: string): Promise<Snapshot[]> {
    const s = await req(this.tx('readonly', HISTORY).index('noteId').getAll(noteId) as IDBRequest<Snapshot[]>);
    return s.sort((a, b) => b.savedAt - a.savedAt);
  }
  async allHistory(): Promise<Snapshot[]> { return req(this.tx('readonly', HISTORY).getAll() as IDBRequest<Snapshot[]>); }

  /** Adds a snapshot if the throttle allows; prunes to `limit`. Returns the snapshot or null. */
  async snapshot(note: Note, opts: { now?: number; force?: boolean; limit?: number; interval?: number } = {}): Promise<Snapshot | null> {
    const now = opts.now ?? Date.now();
    const list = await this.history(note.id);
    if (!shouldSnapshot(list[0], note, now, opts.force, opts.interval)) return null;
    const snap = makeSnapshot(note, now);
    const t = this.db.transaction(HISTORY, 'readwrite');
    const h = t.objectStore(HISTORY);
    h.put(snap);
    [snap, ...list].slice(opts.limit ?? HISTORY_LIMIT).forEach((s) => h.delete(s.id));
    await done(t);
    return snap;
  }

  close(): void { this.db.close(); }
}

// ---------- Import / export ----------
export interface Backup { app: 'marknest'; version: 1 | 2; exportedAt: string; notes: Note[]; history?: Snapshot[] }

export function toBackup(notes: Note[], history: Snapshot[] = [], now = new Date()): string {
  const b: Backup = { app: 'marknest', version: 2, exportedAt: now.toISOString(), notes, history };
  return JSON.stringify(b, null, 2);
}

function isNote(x: unknown): x is Note {
  const n = x as Note;
  return !!n && typeof n.id === 'string' && typeof n.body === 'string' && Array.isArray(n.tags)
    && n.tags.every((t) => typeof t === 'string') && typeof n.createdAt === 'number' && typeof n.updatedAt === 'number';
}
function isSnapshot(x: unknown): x is Snapshot {
  const s = x as Snapshot;
  return !!s && typeof s.id === 'string' && typeof s.noteId === 'string' && typeof s.body === 'string'
    && typeof s.title === 'string' && Array.isArray(s.tags) && typeof s.savedAt === 'number';
}

/** Parse and validate a JSON backup (v1 or v2). Throws on invalid input. */
export function parseBackupFull(json: string): { notes: Note[]; history: Snapshot[] } {
  let data: unknown;
  try { data = JSON.parse(json); } catch { throw new Error('Backup is not valid JSON'); }
  const b = data as Partial<Backup>;
  if (!b || b.app !== 'marknest' || !Array.isArray(b.notes)) throw new Error('Not a MarkNest backup file');
  const bad = b.notes.findIndex((n) => !isNote(n));
  if (bad >= 0) throw new Error(`Invalid note at index ${bad}`);
  const history = Array.isArray(b.history) ? b.history : [];
  const badS = history.findIndex((s) => !isSnapshot(s));
  if (badS >= 0) throw new Error(`Invalid history entry at index ${badS}`);
  const notes = b.notes.map((n) => ({ ...n, title: typeof n.title === 'string' ? n.title : deriveTitle(n.body), tags: unique(n.tags.map(normalizeTag).filter(Boolean)) }));
  return { notes, history };
}

export function parseBackup(json: string): Note[] { return parseBackupFull(json).notes; }

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
