import { describe, it, expect } from 'vitest';
import { formatTime, addMetadataHeader } from '../rag-optimizer';

describe('formatTime', () => {
  it('formats seconds to MM:SS', () => {
    expect(formatTime(90)).toBe('01:30');
  });

  it('formats zero seconds', () => {
    expect(formatTime(0)).toBe('00:00');
  });

  it('formats seconds under a minute', () => {
    expect(formatTime(45)).toBe('00:45');
  });

  it('formats to H:MM:SS when >= 1 hour', () => {
    expect(formatTime(3661)).toBe('1:01:01');
  });

  it('formats exactly one hour', () => {
    expect(formatTime(3600)).toBe('1:00:00');
  });

  it('handles large durations', () => {
    expect(formatTime(36000)).toBe('10:00:00');
  });
});

describe('addMetadataHeader', () => {
  const meta = {
    title: 'Intro to Machine Learning',
    author: 'Dr. Smith',
    platform: 'youtube' as const,
    publishDate: '2024-01-15',
    duration: 3661,
    url: 'https://youtube.com/watch?v=abc123',
  };

  it('includes all metadata fields', () => {
    const result = addMetadataHeader('Some content here', meta);
    expect(result).toContain('Source: Intro to Machine Learning');
    expect(result).toContain('Author: Dr. Smith');
    expect(result).toContain('Platform: youtube');
    expect(result).toContain('Date: 2024-01-15');
    expect(result).toContain('Duration: 1:01:01');
    expect(result).toContain('URL: https://youtube.com/watch?v=abc123');
  });

  it('wraps metadata in YAML-style delimiters', () => {
    const result = addMetadataHeader('Content', meta);
    const lines = result.split('\n');
    expect(lines[0]).toBe('---');
    // Find the closing delimiter
    const closingIndex = lines.indexOf('---', 1);
    expect(closingIndex).toBeGreaterThan(1);
  });

  it('appends the original content after the header', () => {
    const result = addMetadataHeader('My transcript content', meta);
    expect(result).toContain('My transcript content');
    // Content should come after the closing ---
    const closingPos = result.lastIndexOf('---');
    const contentPos = result.indexOf('My transcript content');
    expect(contentPos).toBeGreaterThan(closingPos);
  });

  it('has a blank line between header and content', () => {
    const result = addMetadataHeader('Content', meta);
    expect(result).toContain('---\n\nContent');
  });
});
