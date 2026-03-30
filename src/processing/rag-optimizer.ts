export interface MetadataInput {
  title: string;
  author: string;
  platform: string;
  publishDate: string;
  duration: number;
  url: string;
}

/**
 * Format seconds into MM:SS or H:MM:SS string.
 */
export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');

  if (h > 0) {
    return `${h}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

/**
 * Prepend a YAML-style metadata header to content.
 */
export function addMetadataHeader(content: string, meta: MetadataInput): string {
  const header = [
    '---',
    `Source: ${meta.title}`,
    `Author: ${meta.author}`,
    `Platform: ${meta.platform}`,
    `Date: ${meta.publishDate}`,
    `Duration: ${formatTime(meta.duration)}`,
    `URL: ${meta.url}`,
    '---',
  ].join('\n');

  return `${header}\n\n${content}`;
}
