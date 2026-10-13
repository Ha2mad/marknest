import { describe, it, expect } from 'vitest';
import { highlightCode, supportedLanguages } from '../src/core/highlight';
import { renderMarkdown } from '../src/core/markdown';

describe('syntax highlighting', () => {
  it('highlights known languages and aliases', () => {
    expect(highlightCode('const x = 1;', 'ts')).toContain('<span class="hljs-keyword">const</span>');
    expect(highlightCode('def f(): pass', 'py')).toContain('hljs-keyword');
    expect(supportedLanguages()).toContain('rust');
  });
  it('escapes unknown languages', () => expect(highlightCode('<b>&', 'klingon')).toBe('&lt;b&gt;&amp;'));
  it('renders highlighted, sanitized code blocks', () => {
    const h = renderMarkdown('```js\nconst a = "<img src=x onerror=alert(1)>";\n```');
    expect(h).toContain('class="hljs language-js"');
    expect(h).toContain('hljs-string');
    expect(h).not.toContain('<img');
    expect(h).toContain('&lt;img');
  });
});
