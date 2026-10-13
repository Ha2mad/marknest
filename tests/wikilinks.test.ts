import { describe, it, expect } from 'vitest';
import { extractLinks, backlinks, renameLinks, linkifyWiki, autocompleteQuery, suggestTitles, normTitle } from '../src/core/wikilinks';
import { renderMarkdown } from '../src/core/markdown';

describe('wiki links', () => {
  it('extracts links with labels and ignores code', () => {
    expect(extractLinks('see [[Alpha]] and [[ Beta Note |the beta]]\n`[[nope]]`\n```\n[[nope2]]\n```')).toEqual([
      { target: 'Alpha', label: 'Alpha' }, { target: 'Beta Note', label: 'the beta' },
    ]);
  });
  it('normalizes titles', () => expect(normTitle('  My   Note ')).toBe('my note'));
  it('finds backlinks case-insensitively, excluding self', () => {
    const notes = [
      { id: '1', title: 'Alpha', body: 'self [[alpha]]' },
      { id: '2', title: 'B', body: 'x [[ALPHA]]' },
      { id: '3', title: 'C', body: 'none' },
    ];
    expect(backlinks(notes, 'Alpha', '1').map((n) => n.id)).toEqual(['2']);
  });
  it('renames links, keeping labels and code untouched', () => {
    const body = '[[Old]] [[old|custom label]] [[Other]] `[[Old]]`';
    expect(renameLinks(body, 'Old', 'New Name')).toBe('[[New Name]] [[New Name|custom label]] [[Other]] `[[Old]]`');
    expect(renameLinks(body, 'Old', 'old')).toBe(body);
  });
  it('linkifies with missing-state and escapes labels', () => {
    const h = linkifyWiki('[[A]] [[B|<b>x</b>]]', (t) => t === 'A');
    expect(h).toContain('href="#wiki:A" class="wikilink"');
    expect(h).toContain('class="wikilink missing">&lt;b&gt;x&lt;/b&gt;</a>');
  });
  it('renders safely through markdown + DOMPurify and does not open in a new tab', () => {
    const h = renderMarkdown('go [[My Note]] [[x" onmouseover="alert(1)]]', { noteExists: () => true });
    const doc = new DOMParser().parseFromString(h, 'text/html');
    const links = [...doc.querySelectorAll('a')];
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toBe('#wiki:My%20Note');
    expect(links[0].className).toBe('wikilink');
    for (const a of links) expect(a.getAttributeNames().sort()).toEqual(['class', 'href']);
    expect(doc.querySelector('[onmouseover]')).toBeNull();
  });
  it('detects autocomplete context', () => {
    expect(autocompleteQuery('text [[Pro')).toEqual({ query: 'Pro', start: 7 });
    expect(autocompleteQuery('done [[x]] more')).toBeNull();
    expect(autocompleteQuery('[[a|label')).toBeNull();
  });
  it('suggests prefix matches first', () => {
    expect(suggestTitles(['Project plan', 'My project', 'Pro', 'Other'], 'pro')).toEqual(['Pro', 'Project plan', 'My project']);
  });
});
