import { describe, it, expect } from 'vitest';
import { normalizeTag, parseTagInput, extractInlineTags, noteTags, tagCounts, filterByTags } from '../src/core/tags';

describe('tags', () => {
  it('normalizes', () => {
    expect(normalizeTag(' #Work ')).toBe('work');
    expect(normalizeTag('bad tag')).toBe('');
    expect(normalizeTag('')).toBe('');
  });
  it('parses input', () => expect(parseTagInput('a, B  #c,,a')).toEqual(['a', 'b', 'c']));
  it('extracts inline tags but not headings or code', () => {
    const body = '# Heading\nsome #idea and #Work/Client\n`#notatag`\n```\n#nope\n```\nemail a#b';
    expect(extractInlineTags(body)).toEqual(['idea', 'work/client']);
  });
  it('merges explicit and inline tags', () => expect(noteTags({ tags: ['z'], body: '#a' })).toEqual(['a', 'z']));
  it('counts tags', () => {
    expect(tagCounts([{ tags: ['a'], body: '' }, { tags: ['a', 'b'], body: '' }])).toEqual([{ tag: 'a', count: 2 }, { tag: 'b', count: 1 }]);
  });
  it('filters with AND and nested tags', () => {
    const n = [{ tags: ['work/client', 'urgent'], body: '' }, { tags: ['work'], body: '' }, { tags: ['home'], body: '' }];
    expect(filterByTags(n, ['work'])).toHaveLength(2);
    expect(filterByTags(n, ['work', 'urgent'])).toEqual([n[0]]);
    expect(filterByTags(n, [])).toBe(n);
  });
});
