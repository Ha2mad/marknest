import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { NoteStore, createNote, toBackup, parseBackup, mergeNotes, noteToMarkdown, markdownToNote, safeFilename } from '../src/core/storage';

describe('NoteStore (IndexedDB)', () => {
  it('CRUD round-trip', async () => {
    const s = await NoteStore.open('test-' + Math.random());
    const n1 = createNote('# One', ['A'], 1);
    const n2 = createNote('# Two', [], 2);
    await s.put(n1); await s.put(n2);
    expect((await s.all()).map((n) => n.title)).toEqual(['Two', 'One']);
    expect((await s.get(n1.id))?.tags).toEqual(['a']);
    await s.put({ ...n1, body: 'changed', updatedAt: 3 });
    expect((await s.all())[0].body).toBe('changed');
    await s.delete(n2.id);
    expect(await s.all()).toHaveLength(1);
    await s.putMany([createNote('x'), createNote('y')]);
    expect(await s.all()).toHaveLength(3);
    await s.clear();
    expect(await s.all()).toHaveLength(0);
    s.close();
  });
});

describe('backup & import', () => {
  it('round-trips JSON backups', () => {
    const notes = [createNote('# a', ['t'])];
    expect(parseBackup(toBackup(notes))).toEqual(notes);
  });
  it('rejects invalid backups', () => {
    expect(() => parseBackup('nope')).toThrow(/JSON/);
    expect(() => parseBackup('{"app":"other","notes":[]}')).toThrow(/MarkNest/);
    expect(() => parseBackup('{"app":"marknest","notes":[{"id":1}]}')).toThrow(/index 0/);
  });
  it('merges with newest-wins', () => {
    const a = createNote('a', [], 1);
    const r = mergeNotes([a], [{ ...a, body: 'new', updatedAt: 5 }, createNote('b')]);
    expect(r.added).toBe(1); expect(r.updated).toBe(1);
    expect(r.merged.find((n) => n.id === a.id)?.body).toBe('new');
    expect(mergeNotes([{ ...a, updatedAt: 9 }], [a]).updated).toBe(0);
  });
  it('round-trips markdown front matter', () => {
    const n = createNote('# Hello\nworld', ['x', 'y'], Date.UTC(2026, 0, 1));
    const back = markdownToNote(noteToMarkdown(n));
    expect(back.title).toBe('Hello');
    expect(back.tags).toEqual(['x', 'y']);
    expect(back.body).toBe(n.body);
    expect(back.createdAt).toBe(n.createdAt);
  });
  it('imports plain markdown', () => {
    expect(markdownToNote('', 'file').title).toBe('file');
    expect(markdownToNote('line one\r\nline two').body).toBe('line one\nline two');
  });
  it('makes safe filenames', () => {
    expect(safeFilename('../../etc/passwd: a?b')).toBe('etcpasswd-ab.md');
    expect(safeFilename('***')).toBe('note.md');
  });
});
