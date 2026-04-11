import { describe, it, expect } from 'vitest';
import {
  buildCitationMap,
  buildCitationMapFromProtected,
  injectCitationLinks,
  convertActionItems,
  buildCalloutBlock,
  notionExport,
  citationRegex,
  encapsulateCitations,
  wrapVideoCitationBlock,
  wrapVideoCitationTransport,
  stripVideoCitationFence,
  finalizeForNotion,
  videoCitationsToCitationMap,
  convertNumberedParensToCheckboxes,
} from '../notion-sync';
import type { TranscriptSegment, VideoContent, VideoCitation } from '@/types';

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

const makeSegments = (entries: Array<[number, string]>): TranscriptSegment[] =>
  entries.map(([start, text]) => ({ text, start, duration: 5 }));

const VIDEO_ID = 'dQw4w9WgXcQ';
const VIDEO_DURATION = 600; // 10 minutes

/** Header prepended by finalizeForNotion / injectCitationLinks */
const HEADER_PREFIX = '> \u26A0\uFE0F 改寫規則：所有 [n \u{1F4FA}](URL) 為 YouTube 影片來源連結，改寫時必須保留完整 markdown 連結格式，不可移除 URL。';

const sampleSegments = makeSegments([
  [0, 'Welcome to the video today we will learn about algorithms'],
  [15, 'First lets discuss the basics of sorting'],
  [45, 'Bubble sort is one of the simplest algorithms'],
  [90, 'Now we move on to merge sort which is more efficient'],
  [150, 'The time complexity of merge sort is O n log n'],
  [210, 'Quick sort is another efficient algorithm'],
  [300, 'Lets compare the performance of these algorithms'],
  [420, 'In conclusion sorting algorithms are fundamental'],
]);

const sampleVideoContent: VideoContent = {
  videoId: VIDEO_ID,
  title: 'Sorting Algorithms Explained',
  author: 'CS Channel',
  platform: 'youtube',
  transcript: sampleSegments,
  duration: VIDEO_DURATION,
  language: 'en',
  url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
  metadata: {
    publishDate: '2024-06-15',
    viewCount: 150000,
    tags: ['algorithms', 'sorting'],
  },
};

// ---------------------------------------------------------------------------
// buildCitationMap
// ---------------------------------------------------------------------------

describe('buildCitationMap', () => {
  it('exact match: citation near a [MM:SS] timestamp', () => {
    const text = 'At [01:30] the speaker explains merge sort [1] in detail.';
    const result = buildCitationMap(text, sampleSegments, VIDEO_ID, VIDEO_DURATION);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
    expect(result[0].timestamp).toBe(90); // 01:30 = 90s
    expect(result[0].confidence).toBe('exact');
  });

  it('exact match: multiple citations with different timestamps', () => {
    const text = 'First [00:45] bubble sort [1] then [02:30] merge sort [2] is discussed.';
    const result = buildCitationMap(text, sampleSegments, VIDEO_ID, VIDEO_DURATION);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 1, timestamp: 45, confidence: 'exact' });
    expect(result[1]).toMatchObject({ id: 2, timestamp: 150, confidence: 'exact' });
  });

  it('exact match: handles "at MM:SS" natural language format', () => {
    const text = 'The comparison at 5:00 shows the results [1].';
    const result = buildCitationMap(text, sampleSegments, VIDEO_ID, VIDEO_DURATION);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 1, timestamp: 300, confidence: 'exact' });
  });

  it('exact match: handles (MM:SS) parenthesized format', () => {
    const text = 'Quick sort (3:30) is efficient [1].';
    const result = buildCitationMap(text, sampleSegments, VIDEO_ID, VIDEO_DURATION);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 1, timestamp: 210, confidence: 'exact' });
  });

  it('exact match: handles H:MM:SS format for long videos', () => {
    const text = 'At [1:00:00] the conclusion [1].';
    const longDuration = 7200; // 2 hours
    const result = buildCitationMap(text, sampleSegments, VIDEO_ID, longDuration);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 1, timestamp: 3600, confidence: 'exact' });
  });

  it('fuzzy match: citation without nearby timestamp', () => {
    const text = 'The speaker explains that bubble sort is one of the simplest algorithms [1].';
    const result = buildCitationMap(text, sampleSegments, VIDEO_ID, VIDEO_DURATION);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
    expect(result[0].confidence).toBe('fuzzy');
    // Should map to the bubble sort segment at 45s
    expect(result[0].timestamp).toBe(45);
  });

  it('none: citation with no matching context', () => {
    const text = 'Random unrelated content about cooking [1].';
    const result = buildCitationMap(text, sampleSegments, VIDEO_ID, VIDEO_DURATION);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 1, timestamp: 0, confidence: 'none' });
  });

  it('multiple citations pointing to same second', () => {
    const text = 'At [01:30] the first point [1] and second point [2] are both here.';
    const result = buildCitationMap(text, sampleSegments, VIDEO_ID, VIDEO_DURATION);

    expect(result).toHaveLength(2);
    expect(result[0].timestamp).toBe(90);
    expect(result[1].timestamp).toBe(90);
    expect(result[0].id).toBe(1);
    expect(result[1].id).toBe(2);
  });

  it('citation numbers > 10 are handled correctly', () => {
    const text = 'Point [12] at [00:45] and then [13] later.';
    const result = buildCitationMap(text, sampleSegments, VIDEO_ID, VIDEO_DURATION);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(12);
    expect(result[1].id).toBe(13);
  });

  it('[1] vs [10] do not conflict', () => {
    const text = 'At [00:15] first [1] then at [05:00] tenth [10].';
    const result = buildCitationMap(text, sampleSegments, VIDEO_ID, VIDEO_DURATION);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 1, timestamp: 15 });
    expect(result[1]).toMatchObject({ id: 10, timestamp: 300 });
  });

  it('hallucination defense: rejects timestamps beyond video duration', () => {
    const text = 'At [15:00] the speaker says [1].'; // 900s > 600s duration
    const result = buildCitationMap(text, sampleSegments, VIDEO_ID, VIDEO_DURATION);

    expect(result).toHaveLength(1);
    // Timestamp [15:00] should be rejected, so falls to fuzzy or none
    expect(result[0].confidence).not.toBe('exact');
  });

  it('hallucination defense: pure numbers without colons are ignored', () => {
    // "2025" and "86%" should NOT be treated as timestamps
    const text = 'In 2025 this technique improved by 86% according to [1].';
    const result = buildCitationMap(text, sampleSegments, VIDEO_ID, VIDEO_DURATION);

    expect(result).toHaveLength(1);
    // Should not have an exact match (no colon-containing timestamps found)
    expect(result[0].confidence).not.toBe('exact');
  });

  it('empty text returns empty array', () => {
    expect(buildCitationMap('', sampleSegments, VIDEO_ID, VIDEO_DURATION)).toEqual([]);
  });

  it('text without citations returns empty array', () => {
    const text = 'Just some text with [00:45] timestamps but no citations.';
    expect(buildCitationMap(text, sampleSegments, VIDEO_ID, VIDEO_DURATION)).toEqual([]);
  });

  it('monotonic check: large reverse jump triggers fuzzy fallback', () => {
    // Simulate NLM doing a retrospective summary:
    // First citation at 5:00, then suddenly referencing something at 0:15
    const text = 'At [05:00] the comparison [1] was shown. Earlier at [00:15] basics [2] were covered.';
    const result = buildCitationMap(text, sampleSegments, VIDEO_ID, VIDEO_DURATION);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 1, timestamp: 300, confidence: 'exact' });
    // [2] with reverse jump of 285s (< 600s limit), should still be exact
    expect(result[1].id).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// injectCitationLinks
// ---------------------------------------------------------------------------

describe('injectCitationLinks', () => {
  it('replaces single citation with timestamped link', () => {
    const citations: VideoCitation[] = [
      { id: 1, timestamp: 90, videoId: VIDEO_ID, confidence: 'exact' },
    ];
    const result = injectCitationLinks('The speaker says [1] here.', citations);

    expect(result).toBe(
      `${HEADER_PREFIX}\nThe speaker says [[1] \u{1F4FA}](https://youtube.com/watch?v=${VIDEO_ID}&t=90s) here.`,
    );
  });

  it('replaces multiple citations with different timestamps', () => {
    const citations: VideoCitation[] = [
      { id: 1, timestamp: 45, videoId: VIDEO_ID, confidence: 'exact' },
      { id: 2, timestamp: 150, videoId: VIDEO_ID, confidence: 'fuzzy' },
    ];
    const result = injectCitationLinks('First [1] then [2].', citations);

    expect(result).toContain(`[[1] \u{1F4FA}](https://youtube.com/watch?v=${VIDEO_ID}&t=45s)`);
    expect(result).toContain(`[[2] \u{1F4FA}](https://youtube.com/watch?v=${VIDEO_ID}&t=150s)`);
  });

  it('confidence=none produces link without &t= parameter', () => {
    const citations: VideoCitation[] = [
      { id: 1, timestamp: 0, videoId: VIDEO_ID, confidence: 'none' },
    ];
    const result = injectCitationLinks('Reference [1] here.', citations);

    expect(result).toBe(
      `${HEADER_PREFIX}\nReference [[1] \u{1F4FA}](https://youtube.com/watch?v=${VIDEO_ID}) here.`,
    );
  });

  it('does NOT replace existing markdown links', () => {
    const citations: VideoCitation[] = [
      { id: 1, timestamp: 90, videoId: VIDEO_ID, confidence: 'exact' },
    ];
    const text = 'See [1](https://example.com) for details, and also [1] here.';
    const result = injectCitationLinks(text, citations);

    // The first [1](url) should be untouched; the standalone [1] should be replaced
    expect(result).toContain('[1](https://example.com)');
    expect(result).toContain(`[[1] \u{1F4FA}](https://youtube.com/watch?v=${VIDEO_ID}&t=90s)`);
  });

  it('unmapped citation numbers become MISSING placeholders', () => {
    const citations: VideoCitation[] = [
      { id: 1, timestamp: 90, videoId: VIDEO_ID, confidence: 'exact' },
    ];
    const result = injectCitationLinks('Ref [1] and [2] here.', citations);

    expect(result).toContain(`[[1] \u{1F4FA}]`);
    expect(result).toContain('[[MISSING_2]]');
  });

  it('no citations returns text unchanged (with header)', () => {
    const result = injectCitationLinks('No citations here.', []);
    expect(result).toBe(`${HEADER_PREFIX}\nNo citations here.`);
  });
});

// ---------------------------------------------------------------------------
// convertActionItems
// ---------------------------------------------------------------------------

describe('convertActionItems', () => {
  it('converts "- item" to "- [ ] item"', () => {
    expect(convertActionItems('- Buy groceries')).toBe('- [ ] Buy groceries');
  });

  it('converts "* item" to "- [ ] item"', () => {
    expect(convertActionItems('* Buy groceries')).toBe('- [ ] Buy groceries');
  });

  it('leaves existing "- [ ] item" unchanged', () => {
    expect(convertActionItems('- [ ] Already a checkbox')).toBe('- [ ] Already a checkbox');
  });

  it('leaves existing "- [x] item" unchanged', () => {
    expect(convertActionItems('- [x] Completed')).toBe('- [x] Completed');
  });

  it('preserves and normalizes nested indentation', () => {
    const input = '- Parent\n  - Child\n    - Grandchild';
    const result = convertActionItems(input);

    expect(result).toBe('- [ ] Parent\n  - [ ] Child\n    - [ ] Grandchild');
  });

  it('normalizes tab indentation to 2 spaces', () => {
    const result = convertActionItems('\t- Tabbed item');
    expect(result).toBe('  - [ ] Tabbed item');
  });

  it('normalizes odd-space indentation to even', () => {
    const result = convertActionItems('   - Three spaces');
    expect(result).toBe('    - [ ] Three spaces'); // 3 → 4 (nearest even × 2)
  });

  it('does NOT convert heading lines', () => {
    const input = '### Clinical Effectiveness\n- Item under heading';
    const result = convertActionItems(input);

    expect(result).toBe('### Clinical Effectiveness\n- [ ] Item under heading');
  });

  it('does NOT convert ## or # headings', () => {
    const input = '# Title\n## Section\n- Item';
    const result = convertActionItems(input);

    expect(result).toContain('# Title');
    expect(result).toContain('## Section');
    expect(result).toContain('- [ ] Item');
  });

  it('preserves non-list lines unchanged', () => {
    const input = 'Some paragraph text.\n- List item\nAnother paragraph.';
    const result = convertActionItems(input);

    expect(result).toBe('Some paragraph text.\n- [ ] List item\nAnother paragraph.');
  });

  it('handles mixed content correctly', () => {
    const input = [
      '## Summary',
      '- Key point one',
      '- [ ] Already done',
      '* Another item',
      'Regular text',
      '### Subheading',
      '  - Nested item',
    ].join('\n');

    const result = convertActionItems(input);
    const lines = result.split('\n');

    expect(lines[0]).toBe('## Summary');
    expect(lines[1]).toBe('- [ ] Key point one');
    expect(lines[2]).toBe('- [ ] Already done');
    expect(lines[3]).toBe('- [ ] Another item');
    expect(lines[4]).toBe('Regular text');
    expect(lines[5]).toBe('### Subheading');
    expect(lines[6]).toBe('  - [ ] Nested item');
  });
});

// ---------------------------------------------------------------------------
// buildCalloutBlock
// ---------------------------------------------------------------------------

describe('buildCalloutBlock', () => {
  it('generates complete callout with all fields', () => {
    const result = buildCalloutBlock(sampleVideoContent);

    expect(result).toContain('> [!INFO]');
    expect(result).toContain('Video Source');
    expect(result).toContain('**Title:**');
    expect(result).toContain('Sorting Algorithms Explained');
    expect(result).toContain('**Channel:** CS Channel');
    expect(result).toContain('**Duration:**');
    expect(result).toContain('**Published:** 2024-06-15');
    expect(result).toContain('**Generated by:** [VideoLM]');
  });

  it('omits Published line when publishDate is empty', () => {
    const video = {
      ...sampleVideoContent,
      metadata: { ...sampleVideoContent.metadata, publishDate: '' },
    };
    const result = buildCalloutBlock(video);

    expect(result).not.toContain('**Published:**');
    expect(result).toContain('**Generated by:**');
  });

  it('escapes special markdown characters in title', () => {
    const video = {
      ...sampleVideoContent,
      title: 'Arrays [Part 1] (Advanced)',
    };
    const result = buildCalloutBlock(video);

    // Brackets and parens in title should be escaped
    expect(result).toContain('Arrays \\[Part 1\\] \\(Advanced\\)');
  });

  it('includes video URL as link in title', () => {
    const result = buildCalloutBlock(sampleVideoContent);
    expect(result).toContain(`](${sampleVideoContent.url})`);
  });
});

// ---------------------------------------------------------------------------
// notionExport — Full Pipeline
// ---------------------------------------------------------------------------

describe('notionExport', () => {
  it('all options enabled: callout + checkboxes + timestamp links', () => {
    const text = 'At [00:45] bubble sort [1] is simple.\n- Learn bubble sort\n- Practice merge sort';
    const result = notionExport(text, sampleVideoContent, {
      includeCallout: true,
      includeCheckboxes: true,
      includeTimestampLinks: true,
      includeSpecScript: false,
    });

    // Should have callout at top
    expect(result.markdown).toMatch(/^> \[!INFO\]/);
    // Should have citation link
    expect(result.markdown).toContain(`[[1] \u{1F4FA}]`);
    // Should have checkboxes
    expect(result.markdown).toContain('- [ ] Learn bubble sort');
    expect(result.markdown).toContain('- [ ] Practice merge sort');
    // Stats
    expect(result.citationsTotal).toBe(1);
    expect(result.citationsResolved).toBe(1);
  });

  it('only callout enabled', () => {
    const text = '- Item one [1]\n- Item two';
    const result = notionExport(text, sampleVideoContent, {
      includeCallout: true,
      includeCheckboxes: false,
      includeTimestampLinks: false,
      includeSpecScript: false,
    });

    expect(result.markdown).toMatch(/^> \[!INFO\]/);
    expect(result.markdown).toContain('- Item one [1]'); // [1] not replaced
    expect(result.markdown).not.toContain('- [ ]'); // no checkboxes
    expect(result.citationsTotal).toBe(0);
  });

  it('only checkboxes enabled', () => {
    const text = '- Item one\n- Item two';
    const result = notionExport(text, sampleVideoContent, {
      includeCallout: false,
      includeCheckboxes: true,
      includeTimestampLinks: false,
    });

    expect(result.markdown).not.toContain('> [!INFO]');
    expect(result.markdown).toContain('- [ ] Item one');
    expect(result.markdown).toContain('- [ ] Item two');
  });

  it('only timestamp links enabled', () => {
    const text = 'At [01:30] merge sort [1] is efficient.';
    const result = notionExport(text, sampleVideoContent, {
      includeCallout: false,
      includeCheckboxes: false,
      includeTimestampLinks: true,
    });

    expect(result.markdown).not.toContain('> [!INFO]');
    expect(result.markdown).toContain(`[[1] \u{1F4FA}]`);
    expect(result.citationsResolved).toBe(1);
  });

  it('all options disabled: returns text unchanged', () => {
    const text = '- Item [1]\n- Item [2]';
    const result = notionExport(text, sampleVideoContent, {
      includeCallout: false,
      includeCheckboxes: false,
      includeTimestampLinks: false,
      includeSpecScript: false,
    });

    expect(result.markdown).toBe(text);
    expect(result.citationsTotal).toBe(0);
    expect(result.citationsResolved).toBe(0);
  });

  it('empty text with all options enabled', () => {
    const result = notionExport('', sampleVideoContent, {
      includeCallout: true,
      includeCheckboxes: true,
      includeTimestampLinks: true,
      includeSpecScript: false,
    });

    // Should still have callout
    expect(result.markdown).toContain('> [!INFO]');
    expect(result.citationsTotal).toBe(0);
  });

  it('spec script prepended by default (includeSpecScript omitted)', () => {
    const text = '- Item one\n- Item two';
    const result = notionExport(text, sampleVideoContent, {
      includeCallout: false,
      includeCheckboxes: false,
      includeTimestampLinks: false,
    });

    // Spec script is an HTML comment at the top
    expect(result.markdown).toMatch(/^<!--/);
    expect(result.markdown).toContain('VideoLM Export Spec');
    expect(result.markdown).toContain('-->');
    // Original content follows after the spec block
    expect(result.markdown).toContain(text);
  });

  it('spec script disabled with includeSpecScript: false', () => {
    const text = '- Item one';
    const result = notionExport(text, sampleVideoContent, {
      includeCallout: false,
      includeCheckboxes: false,
      includeTimestampLinks: false,
      includeSpecScript: false,
    });

    expect(result.markdown).toBe(text);
    expect(result.markdown).not.toContain('<!--');
  });
});

// ---------------------------------------------------------------------------
// Citation-safe transport (structured encapsulation)
// ---------------------------------------------------------------------------

describe('Citation-safe transport', () => {
  it('encapsulate → fence → finalize produces Notion markdown links', () => {
    const raw = 'Point A [1] and B [2].';
    const { text: enc, beforeCount } = encapsulateCitations(raw);
    expect(beforeCount).toBe(2);
    expect(enc).toBe(
      'Point A <VIDEO_CITATION id="1"/> and B <VIDEO_CITATION id="2"/>.',
    );
    const map = videoCitationsToCitationMap([
      { id: 1, timestamp: 10, videoId: 'abc', confidence: 'exact' },
      { id: 2, timestamp: 0, videoId: 'abc', confidence: 'none' },
    ]);
    const wrapped = wrapVideoCitationTransport(enc, map);
    expect(wrapped).toContain('VIDEO_CITATION_BLOCK_v1_DO_NOT_TOUCH__SYSTEM');
    expect(wrapped).toContain('<!-- CITATION_MAP');
    const stripped = stripVideoCitationFence(wrapped);
    expect(stripped).toContain('<VIDEO_CITATION id="1"/>');
    const out = finalizeForNotion(wrapped, map);
    expect(out).toContain('[[1] \u{1F4FA}](https://youtube.com/watch?v=abc&t=10s)');
    expect(out).toContain('[[2] \u{1F4FA}](https://youtube.com/watch?v=abc)');
    expect(out).not.toContain('VIDEO_CITATION_BLOCK');
  });

  it('buildCitationMapFromProtected resolves timestamps like plain buildCitationMap', () => {
    const text =
      'At [01:30] the speaker explains merge sort <VIDEO_CITATION id="1"/> in detail.';
    const result = buildCitationMapFromProtected(
      text,
      sampleSegments,
      VIDEO_ID,
      VIDEO_DURATION,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 1, timestamp: 90, confidence: 'exact' });
  });

  it('wrapVideoCitationBlock is fence-only (no CITATION_MAP comment)', () => {
    const enc = 'x <VIDEO_CITATION id="1"/>';
    const s = wrapVideoCitationBlock(enc);
    expect(s).toContain('VIDEO_CITATION_BLOCK_v1_DO_NOT_TOUCH__SYSTEM');
    expect(s).not.toContain('CITATION_MAP');
  });

  it('finalize decodes tolerant tag spacing / case', () => {
    const body = 'x <VIDEO_CITATION  id="7" /> y';
    const map = { '7': { url: 'https://youtube.com/watch?v=z' } };
    const out = finalizeForNotion(body, map, { skipOuterFence: true });
    expect(out).toBe(`${HEADER_PREFIX}\nx [[7] \u{1F4FA}](https://youtube.com/watch?v=z) y`);
  });

  it('convertNumberedParensToCheckboxes: line (n) with n≤20 only', () => {
    expect(convertNumberedParensToCheckboxes('(1) Section intro')).toBe('- [ ] Section intro');
    expect(convertNumberedParensToCheckboxes('(20) Last allowed')).toBe('- [ ] Last allowed');
    expect(convertNumberedParensToCheckboxes('(21) Too large')).toBe('(21) Too large');
    expect(convertNumberedParensToCheckboxes('(2026) Year line')).toBe('(2026) Year line');
  });

  it('citationRegex supports 3-digit bare ids (long talks)', () => {
    const s = 'see ref 101.';
    const re = new RegExp(citationRegex.source, citationRegex.flags);
    const m = re.exec(s);
    expect(m).not.toBeNull();
    expect(m![2]).toBe('101');
  });
});
