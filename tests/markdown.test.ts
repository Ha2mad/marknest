import { describe, it, expect } from 'vitest';
import { renderMarkdown, deriveTitle } from '../src/core/markdown';

describe('markdown rendering & sanitizing', () => {
  it('renders gfm', () => {
    const h = renderMarkdown('# Hi\n\n**b** `c`\n\n| a |\n|---|\n| 1 |');
    expect(h).toContain('<h1');
    expect(h).toContain('<strong>b</strong>');
    expect(h).toContain('<table>');
  });
  const attacks = [
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '<a href="vbscript:msgbox(1)">x</a>',
    '<iframe src="https://evil.example"></iframe>',
    '<svg><script>alert(1)</script></svg>',
    '<div style="background:url(javascript:alert(1))">x</div>',
    '![x](data:text/html;base64,PHNjcmlwdD4=)',
    '<form action="https://evil"><input name=a></form>',
  ];
  for (const a of attacks) {
    it(`neutralizes ${a.slice(0, 30)}`, () => {
      const h = renderMarkdown(a).toLowerCase();
      expect(h).not.toMatch(/<script|onerror|javascript:|vbscript:|<iframe|style=|data:text|<form|type="text"/);
    });
  }
  it('keeps safe links and hardens them', () => {
    const h = renderMarkdown('[ok](https://example.com)');
    expect(h).toContain('href="https://example.com"');
    expect(h).toContain('rel="noopener noreferrer nofollow"');
  });
  it('renders task lists as disabled checkboxes only', () => {
    const h = renderMarkdown('- [x] done\n- [ ] todo\n\n<input type="text" value="x"><input type="checkbox" onclick="alert(1)">');
    expect(h.match(/<input/g)).toHaveLength(3);
    expect(h).not.toContain('type="text"');
    expect(h).not.toContain('onclick');
    expect(h.match(/disabled/g)).toHaveLength(3);
  });
  it('keeps data image urls', () => expect(renderMarkdown('![i](data:image/png;base64,AAAA)')).toContain('src="data:image/png'));
  it('derives titles', () => {
    expect(deriveTitle('\n\n## My Title\nbody')).toBe('My Title');
    expect(deriveTitle('   ')).toBe('Untitled');
  });
});
