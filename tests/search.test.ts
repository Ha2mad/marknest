import { describe, it, expect } from 'vitest';
import { SearchIndex, parseQuery, tokenize, snippet } from '../src/core/search';
import { createNote } from '../src/core/storage';

const a = { ...createNote('# Grocery list\nmilk, eggs, café', ['home']), title: 'Grocery list' };
const b = { ...createNote('# Project plan\nShip the search feature. milk is not here', ['work']), title: 'Project plan' };
const c = { ...createNote('Random thoughts about planning #ideas', []), title: 'Random' };

describe('search', () => {
  it('tokenizes with diacritics folded', () => expect(tokenize('Café-Au Lait!')).toEqual(['cafe', 'au', 'lait']));
  it('parses query syntax', () => {
    expect(parseQuery('foo "big bar" #Tag tag:x -nope')).toEqual({ terms: ['foo'], phrases: ['big bar'], tags: ['tag', 'x'], excluded: ['nope'] });
  });
  const idx = new SearchIndex([a, b, c]);
  it('finds by term and ranks title higher', () => {
    expect(idx.search('grocery').map((h) => h.note.id)).toEqual([a.id]);
    const r = idx.search('plan').map((h) => h.note.id);
    expect(r[0]).toBe(b.id);
    expect(r).toContain(c.id); // prefix match "planning"
  });
  it('requires all terms', () => expect(idx.search('milk ship').map((h) => h.note.id)).toEqual([b.id]));
  it('supports phrases, tags and exclusion', () => {
    expect(idx.search('"search feature"').map((h) => h.note.id)).toEqual([b.id]);
    expect(idx.search('milk #home').map((h) => h.note.id)).toEqual([a.id]);
    expect(idx.search('milk -ship').map((h) => h.note.id)).toEqual([a.id]);
    expect(idx.search('#ideas').map((h) => h.note.id)).toEqual([c.id]);
    expect(idx.search('cafe').map((h) => h.note.id)).toEqual([a.id]);
  });
  it('updates and removes', () => {
    const i = new SearchIndex([a]);
    i.add({ ...a, body: 'bananas' });
    expect(i.search('milk')).toHaveLength(0);
    expect(i.search('bananas')).toHaveLength(1);
    i.remove(a.id);
    expect(i.size).toBe(0);
    expect(i.search('')).toHaveLength(0);
  });
  it('is fast on 5k notes', () => {
    const many = Array.from({ length: 5000 }, (_, k) => createNote(`note ${k} lorem ipsum dolor ${k % 7 === 0 ? 'needle' : 'hay'}`));
    const i = new SearchIndex(many);
    const t = performance.now();
    expect(i.search('needle')).toHaveLength(715);
    expect(performance.now() - t).toBeLessThan(200);
  });
  it('builds snippets', () => {
    expect(snippet('aaa '.repeat(50) + 'target word', 'target', 40)).toContain('target');
  });
});
