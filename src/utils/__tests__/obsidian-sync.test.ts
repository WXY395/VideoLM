import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildObsidianMarkdownFilename,
  finalizeForObsidian,
  obsidianExportFromProtected,
} from '../obsidian-sync';
import {
  wrapVideoCitationTransport,
  type CitationMap,
} from '../notion-sync';

describe('obsidian-sync', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats NotebookLM answers as an Obsidian research note by default', () => {
    const map: CitationMap = {
      '1': {
        url: 'https://youtube.com/watch?v=abc&t=90s',
        sourceName: 'Sorting Algorithms Explained',
      },
    };
    const transport = wrapVideoCitationTransport(
      'Bubble sort is simple <VIDEO_CITATION id="1"/>.',
      map,
    );

    expect(finalizeForObsidian(transport, map, {
      title: 'Algorithm Notes',
      createdAt: '2026-05-02',
    })).toBe(
      [
        '---',
        'type: notebooklm-answer',
        'source: notebooklm',
        'created: 2026-05-02',
        'exported_from: VideoLM',
        'tags:',
        '  - videolm',
        '  - notebooklm',
        '---',
        '',
        '# Algorithm Notes',
        '',
        '## 回答 Answer',
        '',
        'Bubble sort is simple [^1].',
        '',
        '## 來源對照 Evidence Map',
        '',
        '| Ref | Source | Link |',
        '|---|---|---|',
        '| 1 | Sorting Algorithms Explained | https://youtube.com/watch?v=abc&t=90s |',
        '',
        '## 後續行動 Follow-ups',
        '',
        '- [ ] 回到原始來源驗證關鍵主張。',
        '- [ ] 將這則筆記連結到相關主題或專案筆記。',
        '',
        '## 來源 Sources',
        '',
        '[^1]: [Sorting Algorithms Explained](https://youtube.com/watch?v=abc&t=90s)',
      ].join('\n'),
    );
  });

  it('decodes protected citations to Obsidian footnotes with a sources section', () => {
    const map: CitationMap = {
      '1': {
        url: 'https://youtube.com/watch?v=abc&t=90s',
        sourceName: 'Sorting Algorithms Explained',
      },
      '2': {
        url: 'https://youtube.com/watch?v=def',
        sourceName: 'Merge Sort Lecture',
      },
    };
    const transport = wrapVideoCitationTransport(
      'Bubble sort is simple <VIDEO_CITATION id="1"/>. Merge sort is faster <VIDEO_CITATION id="2"/>.',
      map,
    );

    expect(finalizeForObsidian(transport, map, { mode: 'basic' })).toBe(
      [
        'Bubble sort is simple [^1]. Merge sort is faster [^2].',
        '',
        '## Sources',
        '',
        '[^1]: [Sorting Algorithms Explained](https://youtube.com/watch?v=abc&t=90s)',
        '[^2]: [Merge Sort Lecture](https://youtube.com/watch?v=def)',
      ].join('\n'),
    );
  });

  it('uses the local calendar date for default Obsidian created metadata', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 2, 0, 30, 0));

    const result = finalizeForObsidian('Local date note.', {});

    expect(result).toContain('created: 2026-05-02');
  });

  it('deduplicates repeated citation ids in the sources section', () => {
    const map: CitationMap = {
      '1': {
        url: 'https://youtube.com/watch?v=abc',
        sourceName: 'Repeated Source',
      },
    };
    const transport = wrapVideoCitationTransport(
      'First point <VIDEO_CITATION id="1"/> and later the same source <VIDEO_CITATION id="1"/>.',
      map,
    );

    const result = finalizeForObsidian(transport, map);

    expect(result).toContain('First point [^1] and later the same source [^1].');
    expect(result.match(/\[\^1\]:/g)).toHaveLength(1);
  });

  it('keeps unresolved citations readable instead of dropping them', () => {
    const map: CitationMap = {
      '3': {
        url: null,
        sourceName: 'Unknown NotebookLM source',
        status: 'unresolved',
      },
    };
    const transport = wrapVideoCitationTransport(
      'This claim still needs source resolution <VIDEO_CITATION id="3"/>.',
      map,
    );

    expect(finalizeForObsidian(transport, map)).toContain(
      '[^3]: Unresolved source: Unknown NotebookLM source',
    );
  });

  it('returns plain markdown without Notion protection headers', () => {
    const map: CitationMap = {
      '1': { url: 'https://youtube.com/watch?v=abc' },
    };
    const result = obsidianExportFromProtected(
      'Plain note <VIDEO_CITATION id="1"/>.',
      map,
    );

    expect(result).toContain('Plain note [^1].');
    expect(result).not.toContain('改寫規則');
    expect(result).not.toContain('CITATION_MAP');
    expect(result).not.toContain('VIDEO_CITATION_BLOCK');
  });

  it('builds safe Obsidian markdown filenames for downloads', () => {
    expect(buildObsidianMarkdownFilename(
      'Notebook: A/B? C* D.',
      { date: '2026-05-02' },
    )).toBe('Notebook A B C D - 2026-05-02.md');

    expect(buildObsidianMarkdownFilename('', {
      date: '2026-05-02',
    })).toBe('NotebookLM Answer - 2026-05-02.md');

    expect(buildObsidianMarkdownFilename(
      'A'.repeat(200),
      { date: '2026-05-02', maxLength: 40 },
    )).toHaveLength(40);
  });

  it('applies Obsidian filename templates', () => {
    expect(buildObsidianMarkdownFilename('Notebook: Test', {
      date: '2026-05-02',
      template: 'VideoLM/{{date}}/{{notebook_title}}',
    })).toBe('VideoLM 2026-05-02 Notebook Test.md');
  });

  it('can omit optional research-note sections from Obsidian export', () => {
    const map: CitationMap = {
      '1': {
        url: 'https://youtube.com/watch?v=abc',
        sourceName: 'Source A',
      },
    };
    const transport = wrapVideoCitationTransport(
      'Claim <VIDEO_CITATION id="1"/>.',
      map,
    );

    const result = finalizeForObsidian(transport, map, {
      title: 'Slim Note',
      createdAt: '2026-05-02',
      tags: ['custom'],
      includeEvidenceMap: false,
      includeFollowups: false,
      includeSources: false,
    });

    expect(result).toContain('  - custom');
    expect(result).toContain('Claim [^1].');
    expect(result).not.toContain('## 來源對照 Evidence Map');
    expect(result).not.toContain('## 後續行動 Follow-ups');
    expect(result).not.toContain('## 來源 Sources');
  });
});
