import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { NoteStore, createNote, shouldSnapshot, makeSnapshot, toBackup, parseBackupFull, parseBackup, SNAPSHOT_INTERVAL } from '../src/core/storage';
import { diffLines, diffStats } from '../src/core/diff';

const dbName = () => 'h-' + Math.random();

describe('diff', () => {
  it('computes line diffs', () => {
    const ops = diffLines('a\nb\nc', 'a\nB\nc\nd');
    expect(ops).toEqual([
      { type: 'same', text: 'a' }, { type: 'del', text: 'b' }, { type: 'add', text: 'B' }, { type: 'same', text: 'c' }, { type: 'add', text: 'd' },
    ]);
    expect(diffStats(ops)).toEqual({ added: 2, removed: 1 });
    expect(diffStats(diffLines('same', 'same'))).toEqual({ added: 0, removed: 0 });
  });
});

describe('snapshot throttling', () => {
  const n = createNote('hello', [], 0);
  it('rules', () => {
    expect(shouldSnapshot(undefined, n, 0)).toBe(true);
    const s = makeSnapshot(n, 1000);
    expect(shouldSnapshot(s, n, 1000 + SNAPSHOT_INTERVAL * 2, true)).toBe(false); // unchanged
    const changed = { ...n, body: 'changed' };
    expect(shouldSnapshot(s, changed, 2000)).toBe(false); // too soon
    expect(shouldSnapshot(s, changed, 2000, true)).toBe(true); // forced
    expect(shouldSnapshot(s, changed, 1000 + SNAPSHOT_INTERVAL)).toBe(true);
  });
});

describe('history in IndexedDB', () => {
  it('stores, throttles, caps and deletes with note', async () => {
    const s = await NoteStore.open(dbName());
    const n = createNote('v0');
    await s.put(n);
    expect(await s.snapshot(n, { now: 0 })).not.toBeNull();
    expect(await s.snapshot({ ...n, body: 'v1' }, { now: 10 })).toBeNull();
    for (let i = 1; i <= 7; i++) await s.snapshot({ ...n, body: 'v' + i }, { now: i * SNAPSHOT_INTERVAL, limit: 5 });
    const h = await s.history(n.id);
    expect(h).toHaveLength(5);
    expect(h[0].body).toBe('v7');
    expect(h[4].body).toBe('v3');
    const other = createNote('x'); await s.put(other); await s.snapshot(other);
    await s.delete(n.id);
    expect(await s.history(n.id)).toHaveLength(0);
    expect(await s.allHistory()).toHaveLength(1);
    s.close();
  });

  it('migrates a v1 database without losing notes', async () => {
    const name = dbName();
    const legacy = createNote('# Legacy note', ['old']);
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('notes', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
      r.onsuccess = () => {
        const t = r.result.transaction('notes', 'readwrite');
        t.objectStore('notes').put(legacy);
        t.oncomplete = () => { r.result.close(); resolve(); };
      };
      r.onerror = () => reject(r.error);
    });
    const s = await NoteStore.open(name);
    expect(await s.all()).toEqual([legacy]);
    expect(await s.snapshot(legacy)).not.toBeNull();
    expect(await s.history(legacy.id)).toHaveLength(1);
    s.close();
  });
});

describe('backup with history', () => {
  it('round-trips v2 and accepts v1', () => {
    const n = createNote('a');
    const snap = makeSnapshot(n, 5);
    const b = parseBackupFull(toBackup([n], [snap]));
    expect(b.notes).toEqual([n]);
    expect(b.history).toEqual([snap]);
    const v1 = JSON.stringify({ app: 'marknest', version: 1, exportedAt: '', notes: [n] });
    expect(parseBackupFull(v1).history).toEqual([]);
    expect(parseBackup(v1)).toEqual([n]);
  });
  it('rejects malformed history', () => {
    expect(() => parseBackupFull(JSON.stringify({ app: 'marknest', notes: [], history: [{ id: 1 }] }))).toThrow(/history entry at index 0/);
  });
});
