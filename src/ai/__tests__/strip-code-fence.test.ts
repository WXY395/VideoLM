import { describe, it, expect } from 'vitest';
import { stripCodeFence } from '../strip-code-fence';

describe('stripCodeFence', () => {
  it('strips ```markdown ... ``` wrapper', () => {
    expect(stripCodeFence('```markdown\nhello\n```')).toBe('hello');
  });

  it('strips ```md ... ``` wrapper', () => {
    expect(stripCodeFence('```md\nhello\n```')).toBe('hello');
  });

  it('strips bare ``` ... ``` wrapper', () => {
    expect(stripCodeFence('```\nhello\n```')).toBe('hello');
  });

  it('leaves plain text unchanged', () => {
    expect(stripCodeFence('hello')).toBe('hello');
  });

  it('leaves text with only opening ``` (malformed) unchanged', () => {
    expect(stripCodeFence('```markdown\nhello')).toBe('```markdown\nhello');
  });

  it('does not strip when internal ``` exists but no full wrapper', () => {
    const input = "Here's code: ```js\nfoo\n```";
    expect(stripCodeFence(input)).toBe(input);
  });

  it('handles leading/trailing whitespace outside fence', () => {
    expect(stripCodeFence('  ```markdown\nhello\n```  ')).toBe('hello');
  });

  it('strips only outermost fence when content contains nested code blocks', () => {
    const wrapped = '```markdown\nouter\n```js\ninner\n```\n```';
    expect(stripCodeFence(wrapped)).toBe('outer\n```js\ninner\n```');
  });

  it('leaves inline code untouched', () => {
    const input = 'normal text with ```code``` inline';
    expect(stripCodeFence(input)).toBe(input);
  });

  it('handles multi-line content inside fence', () => {
    const input = '```markdown\nline1\nline2\nline3\n```';
    expect(stripCodeFence(input)).toBe('line1\nline2\nline3');
  });

  it('handles CRLF line endings', () => {
    expect(stripCodeFence('```markdown\r\nhello\r\n```')).toBe('hello');
  });

  it('handles empty input', () => {
    expect(stripCodeFence('')).toBe('');
  });

  it('is case-insensitive for language tag', () => {
    expect(stripCodeFence('```Markdown\nhello\n```')).toBe('hello');
    expect(stripCodeFence('```MD\nhello\n```')).toBe('hello');
  });
});
