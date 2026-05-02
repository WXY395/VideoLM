/**
 * Obsidian export helpers.
 *
 * Obsidian reads plain Markdown well, so this formatter intentionally avoids
 * Notion-specific HTML clipboard payloads and protection headers.
 * By default, NotebookLM answers become a compact Obsidian research note with
 * properties, answer text, evidence map, follow-up tasks, and footnotes:
 *
 *   ---
 *   type: notebooklm-answer
 *   ...
 *   ---
 *
 *   ## Answer
 *   Claim text [^1].
 *
 *   ## Evidence Map
 *   | Ref | Source | Link |
 *
 *   ## Sources
 *   [^1]: [Source title](https://youtube.com/...)
 */

import {
  stripVideoCitationFence,
  VIDEO_CITATION_TAG_RE,
  type CitationMap,
} from './notion-sync';

export interface FinalizeObsidianOptions {
  /** Export layout. Default: "research-note". */
  mode?: 'research-note' | 'basic';
  /** H1 title for research-note mode. Default: "NotebookLM Answer". */
  title?: string;
  /** YAML created date. Default: today's ISO date. */
  createdAt?: string;
  /** YAML tags. Default: ["videolm", "notebooklm"]. */
  tags?: string[];
  /** Include the citation evidence table. Default: true. */
  includeEvidenceMap?: boolean;
  /** Include the follow-up checklist. Default: true. */
  includeFollowups?: boolean;
  /** Include footnote source definitions. Default: true. */
  includeSources?: boolean;
  /** Heading used for appended footnote definitions. Default: "Sources". */
  sourcesHeading?: string;
}

export interface ObsidianFilenameOptions {
  /** Used when title is empty after sanitization. Default: "NotebookLM Answer". */
  fallbackTitle?: string;
  /** Date suffix in YYYY-MM-DD. Default: local current date. */
  date?: string;
  /** Template for the filename stem. Supports {{title}}, {{notebook_title}}, {{date}}. */
  template?: string;
  /** Maximum filename length including ".md". Default: 120. */
  maxLength?: number;
}

function escapeMarkdownLinkLabel(text: string): string {
  return text.replace(/([[\]\\])/g, '\\$1');
}

function buildFootnoteDefinition(id: string, citationMap: CitationMap): string {
  const entry = citationMap[id];
  const label = entry?.sourceName?.trim() || `YouTube source ${id}`;

  if (!entry?.url) {
    return `[^${id}]: Unresolved source: ${label}`;
  }

  return `[^${id}]: [${escapeMarkdownLinkLabel(label)}](${entry.url})`;
}

function todayIsoDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function sanitizeFilenameTitle(title: string): string {
  return title
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
}

export function buildObsidianMarkdownFilename(
  title: string,
  options?: ObsidianFilenameOptions,
): string {
  const fallback = options?.fallbackTitle ?? 'NotebookLM Answer';
  const date = options?.date ?? todayIsoDate();
  const maxLength = Math.max(options?.maxLength ?? 120, '.md'.length + 1);
  const sanitized = sanitizeFilenameTitle(title) || sanitizeFilenameTitle(fallback) || 'NotebookLM Answer';
  const template = options?.template?.trim() || '{{title}} - {{date}}';
  const rendered = template
    .replace(/\{\{\s*(title|notebook_title)\s*\}\}/gi, sanitized)
    .replace(/\{\{\s*date\s*\}\}/gi, date);
  const safeStem = sanitizeFilenameTitle(rendered) || `${sanitized} - ${date}`;
  const maxStemLength = maxLength - '.md'.length;
  const trimmedTitle = safeStem.slice(0, maxStemLength).replace(/[. ]+$/g, '') || 'NotebookLM Answer';

  return `${trimmedTitle}.md`;
}

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function decodeProtectedCitations(
  text: string,
): { markdown: string; citationIds: string[] } {
  const body = stripVideoCitationFence(text);
  const citationIds: string[] = [];
  const seen = new Set<string>();

  const tagRe = new RegExp(VIDEO_CITATION_TAG_RE.source, VIDEO_CITATION_TAG_RE.flags);
  const markdown = body.replace(tagRe, (_full, idStr: string) => {
    if (!seen.has(idStr)) {
      seen.add(idStr);
      citationIds.push(idStr);
    }
    return `[^${idStr}]`;
  }).trim();

  return { markdown, citationIds };
}

function sortedCitationIds(ids: string[]): string[] {
  return [...ids].sort((a, b) => Number(a) - Number(b));
}

function buildSourcesSection(
  citationIds: string[],
  citationMap: CitationMap,
  heading: string,
): string {
  const definitions = sortedCitationIds(citationIds)
    .map((id) => buildFootnoteDefinition(id, citationMap));

  return `## ${heading}\n\n${definitions.join('\n')}`;
}

function buildEvidenceMap(citationIds: string[], citationMap: CitationMap): string {
  const rows = sortedCitationIds(citationIds).map((id) => {
    const entry = citationMap[id];
    const label = entry?.sourceName?.trim() || `YouTube source ${id}`;
    const link = entry?.url || '(unresolved)';
    return `| ${id} | ${escapeTableCell(label)} | ${escapeTableCell(link)} |`;
  });

  return [
    '## 來源對照 Evidence Map',
    '',
    '| Ref | Source | Link |',
    '|---|---|---|',
    ...rows,
  ].join('\n');
}

function buildFrontmatter(options?: FinalizeObsidianOptions): string {
  const tags = options?.tags?.length ? options.tags : ['videolm', 'notebooklm'];
  return [
    '---',
    'type: notebooklm-answer',
    'source: notebooklm',
    `created: ${options?.createdAt ?? todayIsoDate()}`,
    'exported_from: VideoLM',
    'tags:',
    ...tags.map((tag) => `  - ${tag}`),
    '---',
  ].join('\n');
}

function buildResearchNote(
  markdown: string,
  citationIds: string[],
  citationMap: CitationMap,
  options?: FinalizeObsidianOptions,
): string {
  const title = options?.title?.trim() || 'NotebookLM Answer';
  const sections = [
    buildFrontmatter(options),
    `# ${title}`,
    '## 回答 Answer',
    markdown,
  ];

  if (citationIds.length > 0 && options?.includeEvidenceMap !== false) {
    sections.push(buildEvidenceMap(citationIds, citationMap));
  }

  if (options?.includeFollowups !== false) {
    sections.push(
      [
        '## 後續行動 Follow-ups',
        '',
        '- [ ] 回到原始來源驗證關鍵主張。',
        '- [ ] 將這則筆記連結到相關主題或專案筆記。',
      ].join('\n'),
    );
  }

  if (citationIds.length > 0 && options?.includeSources !== false) {
    sections.push(buildSourcesSection(
      citationIds,
      citationMap,
      options?.sourcesHeading ?? '來源 Sources',
    ));
  }

  return sections.join('\n\n');
}

/**
 * Decode `<VIDEO_CITATION id="n"/>` into Obsidian footnote references and
 * append a deduplicated footnote source list.
 */
export function finalizeForObsidian(
  text: string,
  citationMap: CitationMap,
  options?: FinalizeObsidianOptions,
): string {
  const { markdown, citationIds } = decodeProtectedCitations(text);

  if (options?.mode !== 'basic') {
    return buildResearchNote(markdown, citationIds, citationMap, options);
  }

  if (citationIds.length === 0) {
    return markdown;
  }

  const heading = options?.sourcesHeading ?? 'Sources';
  return `${markdown}\n\n${buildSourcesSection(citationIds, citationMap, heading)}`;
}

/**
 * Convenience wrapper for protected text produced by copy-handler.
 */
export function obsidianExportFromProtected(
  protectedText: string,
  citationMap: CitationMap,
  options?: FinalizeObsidianOptions,
): string {
  return finalizeForObsidian(protectedText, citationMap, options);
}
