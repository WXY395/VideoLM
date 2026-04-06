import { describe, it, expect } from 'vitest';
import { findMatchingNotebooks, type NlmNotebook } from '../nlm-api';

function makeNotebook(name: string, sourceCount = 0, sourceVideoIds: string[] = []): NlmNotebook {
  return { id: `id-${name}`, name, sourceCount, emoji: '', sourceVideoIds };
}

describe('findMatchingNotebooks', () => {
  const notebooks: NlmNotebook[] = [
    makeNotebook('區塊鏈日報 Blockchain Daily', 50, ['abc', 'def']),
    makeNotebook('區塊鏈日報 Blockchain Daily - Part 2', 30, ['ghi']),
    makeNotebook('Emmy追劇時間', 10),
    makeNotebook('AI', 5),
    makeNotebook('短', 2),
  ];

  it('matches exact name', () => {
    const matches = findMatchingNotebooks(notebooks, '區塊鏈日報 Blockchain Daily');
    expect(matches.length).toBe(2);
    expect(matches[0].name).toBe('區塊鏈日報 Blockchain Daily'); // highest sourceCount
  });

  it('matches when title starts with notebook name (handles truncation)', () => {
    const matches = findMatchingNotebooks(notebooks, '區塊鏈日報 Blockchain Daily — Full Channel');
    expect(matches.length).toBe(2);
  });

  it('matches when notebook name starts with title', () => {
    const matches = findMatchingNotebooks(notebooks, 'Emmy追劇時間');
    expect(matches.length).toBe(1);
    expect(matches[0].name).toBe('Emmy追劇時間');
  });

  it('strips " - Part N" suffix for matching', () => {
    const matches = findMatchingNotebooks(notebooks, '區塊鏈日報 Blockchain Daily - Part 5');
    expect(matches.length).toBe(2); // matches both main and Part 2
  });

  it('does NOT match short Latin names (< 5 chars) to prevent false positives', () => {
    const matches = findMatchingNotebooks(notebooks, 'AI-powered Marketing');
    expect(matches.length).toBe(0); // "AI" is too short for Latin match
  });

  it('does NOT match when Latin title is too short', () => {
    const matches = findMatchingNotebooks(notebooks, 'AI');
    expect(matches.length).toBe(0);
  });

  it('DOES match CJK names (≥ 3 chars) — M-10 FIX raised threshold', () => {
    const cjkNotebooks = [makeNotebook('小船頻道', 17)];
    const matches = findMatchingNotebooks(cjkNotebooks, '小船頻道');
    expect(matches.length).toBe(1);
    expect(matches[0].name).toBe('小船頻道');
  });

  it('does NOT match very short CJK names (< 3 chars) — M-10 FIX raised threshold', () => {
    const cjkNotebooks = [makeNotebook('小船', 17)];
    const matches = findMatchingNotebooks(cjkNotebooks, '小船');
    expect(matches.length).toBe(0); // 2 CJK chars below new threshold of 3
  });

  it('does NOT match single CJK char (< 3 chars)', () => {
    const matches = findMatchingNotebooks(notebooks, '短');
    expect(matches.length).toBe(0);
  });

  it('returns empty for empty title', () => {
    expect(findMatchingNotebooks(notebooks, '')).toEqual([]);
  });

  it('returns empty for no notebooks', () => {
    expect(findMatchingNotebooks([], 'Some Title')).toEqual([]);
  });

  it('sorts by sourceCount descending (main notebook first)', () => {
    const matches = findMatchingNotebooks(notebooks, '區塊鏈日報 Blockchain Daily');
    expect(matches[0].sourceCount).toBeGreaterThanOrEqual(matches[1].sourceCount);
  });
});
