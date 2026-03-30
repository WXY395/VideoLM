import { describe, it, expect } from 'vitest';
import { similarity, checkDuplicateByTitle } from '../duplicate-detector';

describe('similarity', () => {
  it('returns 1 for identical strings', () => {
    expect(similarity('hello', 'hello')).toBe(1);
  });

  it('returns 0 for completely different strings', () => {
    expect(similarity('abc', 'xyz')).toBe(0);
  });

  it('returns < 0.5 for very different strings', () => {
    expect(similarity('hello world', 'xyz abc 123')).toBeLessThan(0.5);
  });

  it('returns > 0.8 for similar strings', () => {
    expect(similarity('Introduction to Machine Learning', 'Introduction to Machine Learnng')).toBeGreaterThan(0.8);
  });

  it('handles empty strings', () => {
    expect(similarity('', '')).toBe(1);
    expect(similarity('abc', '')).toBe(0);
    expect(similarity('', 'abc')).toBe(0);
  });
});

describe('checkDuplicateByTitle', () => {
  const existingSources = [
    { title: 'Intro to ML - Dr. Smith', url: 'https://youtube.com/watch?v=abc123' },
    { title: 'Advanced React Patterns', url: 'https://youtube.com/watch?v=def456' },
    { title: 'TypeScript Best Practices' },
  ];

  it('detects exact match by videoId in URL', () => {
    const result = checkDuplicateByTitle('abc123', 'Some Other Title', existingSources);
    expect(result.isDuplicate).toBe(true);
    expect(result.matchType).toBe('exact');
    expect(result.existingTitle).toBe('Intro to ML - Dr. Smith');
    expect(result.suggestion).toBeDefined();
  });

  it('detects fuzzy match by similar title', () => {
    const result = checkDuplicateByTitle('zzz999', 'Advanced React Pattern', existingSources);
    expect(result.isDuplicate).toBe(true);
    expect(result.matchType).toBe('fuzzy');
    expect(result.existingTitle).toBe('Advanced React Patterns');
  });

  it('returns not duplicate for unique content', () => {
    const result = checkDuplicateByTitle('zzz999', 'Completely New Video Topic', existingSources);
    expect(result.isDuplicate).toBe(false);
    expect(result.matchType).toBeUndefined();
    expect(result.existingTitle).toBeUndefined();
  });

  it('handles empty existing sources', () => {
    const result = checkDuplicateByTitle('abc123', 'Some Title', []);
    expect(result.isDuplicate).toBe(false);
  });

  it('detects exact match by videoId in title', () => {
    const sources = [{ title: 'Video abc123 - Intro' }];
    const result = checkDuplicateByTitle('abc123', 'Different Title', sources);
    expect(result.isDuplicate).toBe(true);
    expect(result.matchType).toBe('exact');
  });
});
