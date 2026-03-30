# VideoLM MVP Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Chrome Extension (Manifest V3) that extracts YouTube video transcripts, processes them with AI (structured summary, semantic chunking, translation), and imports them into Google NotebookLM with a three-tier fallback strategy.

**Architecture:** Chrome Extension with React popup, per-platform content scripts, and a Background Service Worker that routes to a Cloudflare Workers serverless backend. NotebookLM integration uses Fetch interception (Tier 1), DOM automation (Tier 2), and clipboard fallback (Tier 3). AI processing supports BYOK and built-in providers.

**Tech Stack:** TypeScript, React 18, Vite + CRXJS, Manifest V3, Cloudflare Workers (Hono), Vitest, Claude/OpenAI APIs

**Design Doc:** `docs/plans/2026-03-30-videolm-design.md`

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `manifest.json`
- Create: `src/background/service-worker.ts`
- Create: `src/popup/index.html`
- Create: `src/popup/main.tsx`
- Create: `src/popup/App.tsx`
- Create: `src/content-scripts/youtube.ts`
- Create: `src/content-scripts/notebooklm.ts`
- Create: `src/types/index.ts`
- Create: `.gitignore`

**Step 1: Initialize git repo**

```bash
cd "F:/Youtube to NotebookLM"
git init
```

**Step 2: Create package.json and install dependencies**

```bash
npm init -y
npm install react react-dom
npm install -D typescript @types/react @types/react-dom @crxjs/vite-plugin@beta vite vitest @testing-library/react @testing-library/jest-dom jsdom
```

**Step 3: Create project structure**

Create all scaffolding files with minimal content:

`manifest.json`:
```json
{
  "manifest_version": 3,
  "name": "VideoLM — AI Video to NotebookLM",
  "version": "0.1.0",
  "description": "Extract, enhance, and import video content into NotebookLM with AI-powered pre-processing.",
  "permissions": ["activeTab", "storage", "scripting"],
  "host_permissions": [
    "https://www.youtube.com/*",
    "https://notebooklm.google.com/*"
  ],
  "action": {
    "default_popup": "src/popup/index.html"
  },
  "background": {
    "service_worker": "src/background/service-worker.ts",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["https://www.youtube.com/watch*"],
      "js": ["src/content-scripts/youtube.ts"]
    },
    {
      "matches": ["https://notebooklm.google.com/*"],
      "js": ["src/content-scripts/notebooklm.ts"]
    }
  ],
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["chrome"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

Install Chrome types:
```bash
npm install -D @types/chrome
```

`vite.config.ts`:
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

export default defineConfig({
  plugins: [
    react(),
    crx({ manifest }),
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
```

Install React Vite plugin:
```bash
npm install -D @vitejs/plugin-react
```

`src/types/index.ts`:
```typescript
export interface TranscriptSegment {
  start: number;
  duration: number;
  text: string;
}

export interface Chapter {
  title: string;
  startTime: number;
  endTime: number;
  segments: TranscriptSegment[];
}

export interface VideoContent {
  platform: 'youtube' | 'tiktok' | 'xiaohongshu';
  videoId: string;
  title: string;
  author: string;
  url: string;
  duration: number;
  language: string;
  chapters?: Chapter[];
  transcript: TranscriptSegment[];
  metadata: {
    publishDate: string;
    viewCount: number;
    tags: string[];
  };
}

export type ImportMode = 'raw' | 'structured' | 'summary' | 'chapters';

export interface ImportOptions {
  mode: ImportMode;
  translate?: string; // target language code
  notebookId?: string;
}

export type ImportTier = 1 | 2 | 3;

export interface ImportResult {
  success: boolean;
  tier: ImportTier;
  manual?: boolean;
  message?: string;
  error?: string;
}

export interface DynamicConfig {
  version: string;
  nlm: {
    selectors: {
      addSourceButton: string[];
      sourceTypeMenu: string[];
      copiedTextOption: string[];
      textInput: string[];
      urlInput: string[];
      submitButton: string[];
      notebookList: string[];
      sourceList: string[];
    };
    apiPatterns: {
      addSource: string;
      listNotebooks: string;
    };
  };
  features: {
    fetchInterceptEnabled: boolean;
    domAutomationEnabled: boolean;
    maxBatchSize: number;
  };
}

export interface AIProvider {
  name: string;
  summarize(transcript: string, videoTitle: string, mode: ImportMode): Promise<string>;
  splitChapters(transcript: string): Promise<Chapter[]>;
  translate(content: string, targetLang: string): Promise<string>;
}

export type AIProviderType = 'openai' | 'anthropic' | 'builtin' | 'gemini-nano' | 'none';

export interface BYOKConfig {
  provider: AIProviderType;
  apiKey: string;
  model?: string;
}

export interface UserSettings {
  tier: 'free' | 'pro';
  byok?: BYOKConfig;
  defaultMode: ImportMode;
  defaultTranslateLang?: string;
  monthlyUsage: {
    imports: number;
    aiCalls: number;
    resetDate: string;
  };
}

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  matchType?: 'exact' | 'fuzzy';
  existingTitle?: string;
  suggestion?: string;
}

// Message types for Extension internal communication
export type MessageType =
  | { type: 'GET_VIDEO_CONTENT'; }
  | { type: 'VIDEO_CONTENT'; data: VideoContent }
  | { type: 'IMPORT_TO_NLM'; content: string; options: ImportOptions }
  | { type: 'IMPORT_RESULT'; result: ImportResult }
  | { type: 'API_FORMAT_CAPTURED'; data: unknown }
  | { type: 'GET_SOURCE_LIST' }
  | { type: 'SOURCE_LIST'; data: Array<{ title: string; url?: string }> }
  | { type: 'GET_CONFIG' }
  | { type: 'CONFIG'; data: DynamicConfig };
```

`src/background/service-worker.ts`:
```typescript
// VideoLM Background Service Worker
// Handles message routing between content scripts and popup

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Will be implemented in subsequent tasks
  return true; // keep channel open for async response
});
```

`src/popup/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VideoLM</title>
</head>
<body>
  <div id="root" style="width: 360px; min-height: 400px;"></div>
  <script type="module" src="./main.tsx"></script>
</body>
</html>
```

`src/popup/main.tsx`:
```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
```

`src/popup/App.tsx`:
```tsx
import React from 'react';

export function App() {
  return (
    <div style={{ padding: '16px', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: '18px', margin: 0 }}>VideoLM</h1>
      <p style={{ color: '#666', fontSize: '13px' }}>AI Video to NotebookLM</p>
    </div>
  );
}
```

`src/content-scripts/youtube.ts`:
```typescript
// YouTube Content Script — transcript extraction
// Will be fully implemented in Task 2
console.log('[VideoLM] YouTube content script loaded');
```

`src/content-scripts/notebooklm.ts`:
```typescript
// NotebookLM Content Script — Fetch interception + DOM automation
// Will be fully implemented in Task 5
console.log('[VideoLM] NotebookLM content script loaded');
```

`src/test-setup.ts`:
```typescript
import '@testing-library/jest-dom';
```

`.gitignore`:
```
node_modules/
dist/
.vite/
*.local
```

**Step 4: Create placeholder icons**

```bash
mkdir -p icons
# Create simple placeholder PNGs (will be replaced with real icons later)
```

**Step 5: Verify build works**

```bash
npx vite build
```

Expected: Build succeeds, `dist/` folder created with extension files.

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: scaffold VideoLM Chrome Extension project

Manifest V3 + React + Vite + CRXJS setup with TypeScript types,
placeholder content scripts for YouTube and NotebookLM, and
minimal popup UI shell."
```

---

## Task 2: YouTube Transcript Extractor

**Files:**
- Create: `src/extractors/youtube-extractor.ts`
- Create: `src/extractors/__tests__/youtube-extractor.test.ts`
- Modify: `src/content-scripts/youtube.ts`

**Step 1: Write the failing tests**

`src/extractors/__tests__/youtube-extractor.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { parseXMLCaptions, formatTranscript, extractVideoId } from '../youtube-extractor';

describe('extractVideoId', () => {
  it('extracts video ID from standard YouTube URL', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('extracts video ID from URL with extra params', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=abc123&list=PLxyz')).toBe('abc123');
  });

  it('returns null for non-YouTube URLs', () => {
    expect(extractVideoId('https://example.com')).toBeNull();
  });
});

describe('parseXMLCaptions', () => {
  const sampleXML = `<?xml version="1.0" encoding="utf-8" ?>
<transcript>
  <text start="0.5" dur="2.3">Hello world</text>
  <text start="3.1" dur="1.8">This is a test</text>
  <text start="5.2" dur="2.0">Of the transcript parser</text>
</transcript>`;

  it('parses XML captions into TranscriptSegment array', () => {
    const result = parseXMLCaptions(sampleXML);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ start: 0.5, duration: 2.3, text: 'Hello world' });
    expect(result[1]).toEqual({ start: 3.1, duration: 1.8, text: 'This is a test' });
  });

  it('decodes HTML entities in caption text', () => {
    const xml = `<transcript><text start="0" dur="1">It&#39;s &amp; good &lt;test&gt;</text></transcript>`;
    const result = parseXMLCaptions(xml);
    expect(result[0].text).toBe("It's & good <test>");
  });

  it('returns empty array for invalid XML', () => {
    expect(parseXMLCaptions('not xml')).toEqual([]);
  });
});

describe('formatTranscript', () => {
  it('formats segments into plain text with timestamps', () => {
    const segments = [
      { start: 0, duration: 2, text: 'Hello' },
      { start: 65, duration: 3, text: 'World' },
      { start: 3661, duration: 2, text: 'End' },
    ];
    const result = formatTranscript(segments);
    expect(result).toContain('[00:00]');
    expect(result).toContain('[01:05]');
    expect(result).toContain('[1:01:01]');
    expect(result).toContain('Hello');
  });

  it('formats segments as plain text without timestamps', () => {
    const segments = [
      { start: 0, duration: 2, text: 'Hello' },
      { start: 3, duration: 2, text: 'World' },
    ];
    const result = formatTranscript(segments, { timestamps: false });
    expect(result).not.toContain('[');
    expect(result).toBe('Hello World');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/extractors/__tests__/youtube-extractor.test.ts
```

Expected: FAIL — module not found.

**Step 3: Write the YouTube extractor**

`src/extractors/youtube-extractor.ts`:
```typescript
import type { TranscriptSegment, VideoContent, Chapter } from '../types';

export function extractVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('youtube.com')) return null;
    return parsed.searchParams.get('v');
  } catch {
    return null;
  }
}

export function parseXMLCaptions(xml: string): TranscriptSegment[] {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    const texts = doc.querySelectorAll('text');
    return Array.from(texts).map((node) => ({
      start: parseFloat(node.getAttribute('start') || '0'),
      duration: parseFloat(node.getAttribute('dur') || '0'),
      text: decodeHTMLEntities(node.textContent || ''),
    }));
  } catch {
    return [];
  }
}

function decodeHTMLEntities(text: string): string {
  const textarea = document.createElement('textarea');
  textarea.innerHTML = text;
  return textarea.value;
}

export function formatTranscript(
  segments: TranscriptSegment[],
  options: { timestamps?: boolean } = { timestamps: true }
): string {
  if (!options.timestamps) {
    return segments.map((s) => s.text).join(' ');
  }
  return segments
    .map((s) => `[${formatTime(s.start)}] ${s.text}`)
    .join('\n');
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Extract caption tracks from YouTube's player response.
 * Called from the content script where ytInitialPlayerResponse is available.
 */
export function extractCaptionTracks(playerResponse: any): Array<{
  languageCode: string;
  baseUrl: string;
  name: string;
  isAutoGenerated: boolean;
}> {
  try {
    const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks)) return [];
    return tracks.map((t: any) => ({
      languageCode: t.languageCode || '',
      baseUrl: t.baseUrl || '',
      name: t.name?.simpleText || t.languageCode || '',
      isAutoGenerated: (t.kind === 'asr'),
    }));
  } catch {
    return [];
  }
}

/**
 * Extract YouTube chapter markers from the player response.
 */
export function extractChapters(playerResponse: any): Chapter[] {
  try {
    const chapters = playerResponse?.playerOverlays
      ?.playerOverlayRenderer?.decoratedPlayerBarRenderer
      ?.decoratedPlayerBarRenderer?.playerBar?.multiMarkersPlayerBarRenderer
      ?.markersMap?.[0]?.value?.chapters;
    if (!Array.isArray(chapters)) return [];
    return chapters.map((ch: any, i: number, arr: any[]) => {
      const renderer = ch.chapterRenderer;
      const startTime = renderer?.timeRangeStartMillis / 1000 || 0;
      const endTime = i < arr.length - 1
        ? (arr[i + 1].chapterRenderer?.timeRangeStartMillis / 1000 || 0)
        : Infinity;
      return {
        title: renderer?.title?.simpleText || `Chapter ${i + 1}`,
        startTime,
        endTime,
        segments: [], // filled later when transcript is loaded
      };
    });
  } catch {
    return [];
  }
}

/**
 * Extract video metadata from the player response.
 */
export function extractVideoMetadata(playerResponse: any): Partial<VideoContent> {
  try {
    const details = playerResponse?.videoDetails;
    return {
      videoId: details?.videoId || '',
      title: details?.title || '',
      author: details?.author || '',
      duration: parseInt(details?.lengthSeconds || '0', 10),
      metadata: {
        publishDate: '', // not in playerResponse, would need microformat
        viewCount: parseInt(details?.viewCount || '0', 10),
        tags: details?.keywords || [],
      },
    };
  } catch {
    return {};
  }
}

/**
 * Full extraction pipeline — called from content script.
 * Fetches caption XML from the best available track and builds VideoContent.
 */
export async function extractFullVideoContent(
  playerResponse: any,
  url: string
): Promise<VideoContent | null> {
  const meta = extractVideoMetadata(playerResponse);
  const captionTracks = extractCaptionTracks(playerResponse);
  const chapters = extractChapters(playerResponse);

  if (captionTracks.length === 0) {
    return null; // no captions available — would need Whisper fallback
  }

  // Prefer manual captions over auto-generated
  const manual = captionTracks.find((t) => !t.isAutoGenerated);
  const track = manual || captionTracks[0];

  // Fetch caption XML
  const response = await fetch(track.baseUrl);
  const xml = await response.text();
  const segments = parseXMLCaptions(xml);

  // Map segments into chapters if available
  const populatedChapters = chapters.map((ch) => ({
    ...ch,
    segments: segments.filter(
      (s) => s.start >= ch.startTime && s.start < ch.endTime
    ),
  }));

  return {
    platform: 'youtube',
    videoId: meta.videoId || extractVideoId(url) || '',
    title: meta.title || '',
    author: meta.author || '',
    url,
    duration: meta.duration || 0,
    language: track.languageCode,
    chapters: populatedChapters.length > 0 ? populatedChapters : undefined,
    transcript: segments,
    metadata: meta.metadata || { publishDate: '', viewCount: 0, tags: [] },
  };
}
```

**Step 4: Update YouTube content script**

`src/content-scripts/youtube.ts`:
```typescript
import { extractFullVideoContent } from '../extractors/youtube-extractor';
import type { VideoContent } from '../types';

let cachedContent: VideoContent | null = null;

async function extractContent(): Promise<VideoContent | null> {
  // Access YouTube's player response from the page context
  const playerResponse = await getPlayerResponse();
  if (!playerResponse) return null;
  return extractFullVideoContent(playerResponse, window.location.href);
}

async function getPlayerResponse(): Promise<any> {
  // ytInitialPlayerResponse is set by YouTube on the page
  // Content scripts can't directly access page JS variables,
  // so we inject a script to extract it
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.textContent = `
      window.postMessage({
        type: '__VIDEOLM_PLAYER_RESPONSE__',
        data: window.ytInitialPlayerResponse
      }, '*');
    `;
    document.documentElement.appendChild(script);
    script.remove();

    const handler = (event: MessageEvent) => {
      if (event.data?.type === '__VIDEOLM_PLAYER_RESPONSE__') {
        window.removeEventListener('message', handler);
        resolve(event.data.data);
      }
    };
    window.addEventListener('message', handler);

    // Timeout after 3 seconds
    setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve(null);
    }, 3000);
  });
}

// Listen for messages from popup/background
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_VIDEO_CONTENT') {
    if (cachedContent) {
      sendResponse({ type: 'VIDEO_CONTENT', data: cachedContent });
    } else {
      extractContent().then((content) => {
        cachedContent = content;
        sendResponse({ type: 'VIDEO_CONTENT', data: content });
      });
    }
    return true; // async response
  }
});

// Re-extract on navigation (YouTube SPA)
let lastUrl = window.location.href;
const observer = new MutationObserver(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    cachedContent = null;
  }
});
observer.observe(document.body, { childList: true, subtree: true });
```

**Step 5: Run tests to verify they pass**

```bash
npx vitest run src/extractors/__tests__/youtube-extractor.test.ts
```

Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/extractors/ src/content-scripts/youtube.ts
git commit -m "feat: YouTube transcript extractor with XML parsing, chapter detection, and metadata extraction"
```

---

## Task 3: AI Provider System (BYOK + Built-in)

**Files:**
- Create: `src/ai/provider-manager.ts`
- Create: `src/ai/providers/openai-direct.ts`
- Create: `src/ai/providers/anthropic-direct.ts`
- Create: `src/ai/providers/builtin.ts`
- Create: `src/ai/providers/no-ai.ts`
- Create: `src/ai/prompts.ts`
- Create: `src/ai/__tests__/provider-manager.test.ts`
- Create: `src/ai/__tests__/prompts.test.ts`

**Step 1: Write the failing tests**

`src/ai/__tests__/provider-manager.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { resolveProvider } from '../provider-manager';
import type { UserSettings } from '../../types';

describe('resolveProvider', () => {
  it('returns NoAIProvider when free tier and no BYOK', () => {
    const settings: UserSettings = {
      tier: 'free',
      defaultMode: 'raw',
      monthlyUsage: { imports: 0, aiCalls: 0, resetDate: '2026-04-01' },
    };
    const provider = resolveProvider(settings);
    expect(provider.name).toBe('none');
  });

  it('returns OpenAI BYOK provider when API key is set', () => {
    const settings: UserSettings = {
      tier: 'free',
      byok: { provider: 'openai', apiKey: 'sk-test123', model: 'gpt-4o-mini' },
      defaultMode: 'structured',
      monthlyUsage: { imports: 0, aiCalls: 0, resetDate: '2026-04-01' },
    };
    const provider = resolveProvider(settings);
    expect(provider.name).toBe('openai');
  });

  it('returns Anthropic BYOK provider when configured', () => {
    const settings: UserSettings = {
      tier: 'free',
      byok: { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-haiku-4-5-20251001' },
      defaultMode: 'structured',
      monthlyUsage: { imports: 0, aiCalls: 0, resetDate: '2026-04-01' },
    };
    const provider = resolveProvider(settings);
    expect(provider.name).toBe('anthropic');
  });

  it('returns builtin provider for pro tier', () => {
    const settings: UserSettings = {
      tier: 'pro',
      defaultMode: 'structured',
      monthlyUsage: { imports: 0, aiCalls: 0, resetDate: '2026-04-01' },
    };
    const provider = resolveProvider(settings);
    expect(provider.name).toBe('builtin');
  });

  it('prefers BYOK over builtin even for pro users', () => {
    const settings: UserSettings = {
      tier: 'pro',
      byok: { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o' },
      defaultMode: 'structured',
      monthlyUsage: { imports: 0, aiCalls: 0, resetDate: '2026-04-01' },
    };
    const provider = resolveProvider(settings);
    expect(provider.name).toBe('openai');
  });
});
```

`src/ai/__tests__/prompts.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { buildStructuredPrompt, buildChapterSplitPrompt, buildSummaryPrompt } from '../prompts';

describe('buildStructuredPrompt', () => {
  it('includes video metadata in prompt', () => {
    const prompt = buildStructuredPrompt('Hello world transcript', 'Test Video', 'Author', '10:00', 'en');
    expect(prompt).toContain('Test Video');
    expect(prompt).toContain('Author');
    expect(prompt).toContain('10:00');
  });

  it('includes transcript in prompt', () => {
    const prompt = buildStructuredPrompt('My transcript text here', 'Title', 'Author', '5:00', 'en');
    expect(prompt).toContain('My transcript text here');
  });

  it('includes RAG optimization instructions', () => {
    const prompt = buildStructuredPrompt('text', 'title', 'author', '1:00', 'en');
    expect(prompt).toContain('NotebookLM');
    expect(prompt).toContain('RAG');
  });
});

describe('buildChapterSplitPrompt', () => {
  it('includes transcript and JSON output format instructions', () => {
    const prompt = buildChapterSplitPrompt('transcript with segments');
    expect(prompt).toContain('transcript with segments');
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('chapterTitle');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/ai/__tests__/
```

**Step 3: Write AI prompt templates**

`src/ai/prompts.ts`:
```typescript
export function buildStructuredPrompt(
  transcript: string,
  title: string,
  author: string,
  duration: string,
  language: string
): string {
  return `You are a professional academic note organizer. Convert the following video transcript into a high-quality research note, optimized for knowledge management systems (NotebookLM) that use RAG (Retrieval-Augmented Generation) for information retrieval.

## Input
Video Title: ${title}
Author: ${author}
Duration: ${duration}
Language: ${language}

Transcript:
${transcript}

## Output Requirements

### 1. Metadata Block (top)
- Title, author, date, duration
- 3-5 keyword tags
- One-sentence summary (under 20 words)

### 2. Structured Outline
- Use Markdown H2/H3 hierarchy
- Mark each section with corresponding timestamp range [MM:SS-MM:SS]
- Headings must be semantically descriptive (NOT "Part 1", "Section 2")

### 3. Key Arguments (with citations)
- List 5-10 core points
- Each point with a direct quote from the video (with timestamp)
- Mark as "Fact" or "Opinion"

### 4. Glossary
- List technical terms with brief definitions
- Only non-common specialized vocabulary

### 5. Quality Rules
- Remove filler words (um, uh, like, you know)
- Merge fragmented sentences into complete statements
- Fix obvious speech recognition errors
- Preserve technical terms in their original language

## Critical Principle
Your output will be ingested into NotebookLM as a Source. NotebookLM uses RAG to retrieve information from Sources.
Therefore, structure your output so that key information is maximally retrievable by the RAG system:
- Each H2 section should be a self-contained knowledge unit
- Use clear semantic headings (not vague titles)
- Key terms should appear naturally within the first 50 words of each section`;
}

export function buildSummaryPrompt(
  transcript: string,
  title: string,
  author: string,
  language: string
): string {
  return `Summarize the following video transcript into a concise research brief.

Video: "${title}" by ${author} (Language: ${language})

Transcript:
${transcript}

Output a brief containing:
1. Executive Summary (3-5 sentences)
2. Key Takeaways (5-8 bullet points)
3. Notable Quotes (2-3 direct quotes with timestamps)
4. Glossary of specialized terms

Keep the total output under 800 words. Optimize for NotebookLM RAG retrieval — each section should be a self-contained knowledge unit.`;
}

export function buildChapterSplitPrompt(transcript: string): string {
  return `You are a content structure analyst. Analyze the following video transcript and split it into 3-8 logically independent chapters.

Transcript:
${transcript}

## Splitting Rules
1. Each chapter must be a self-contained knowledge unit — understandable when read alone
2. Chapter titles must be semantically descriptive (e.g., "Backpropagation in Neural Networks" not "Part 3")
3. Each chapter should be 300-2000 words (too short = no context, too long = reduces RAG precision)
4. Split points must be at natural topic transitions

## Output Format (JSON)
Return a JSON array:
[
  {
    "chapterTitle": "Descriptive semantic title",
    "startTime": 0,
    "endTime": 342,
    "summary": "Chapter summary in under 50 words",
    "keyTerms": ["term1", "term2"],
    "content": "Full cleaned chapter content..."
  }
]

## Content Type Detection
- Tutorial → split by knowledge points
- Interview → split by discussion topics
- News → split by reported events
- Short video (<5 min) → keep 1-2 chapters max`;
}

export function buildTranslatePrompt(content: string, targetLang: string): string {
  return `Translate the following structured research note to ${targetLang}.
Preserve all Markdown formatting, timestamps, and structure.
Keep technical terms in their original language with translation in parentheses on first occurrence.

Content:
${content}`;
}
```

**Step 4: Write AI provider implementations**

`src/ai/providers/no-ai.ts`:
```typescript
import type { AIProvider, Chapter } from '../../types';

export class NoAIProvider implements AIProvider {
  name = 'none';

  async summarize(transcript: string): Promise<string> {
    // No AI — just return cleaned transcript
    return transcript;
  }

  async splitChapters(): Promise<Chapter[]> {
    return []; // Cannot split without AI
  }

  async translate(): Promise<string> {
    throw new Error('Translation requires an AI provider. Set up a BYOK API key or upgrade to Pro.');
  }
}
```

`src/ai/providers/openai-direct.ts`:
```typescript
import type { AIProvider, Chapter, ImportMode } from '../../types';
import { buildStructuredPrompt, buildSummaryPrompt, buildChapterSplitPrompt, buildTranslatePrompt } from '../prompts';

export class OpenAIDirectProvider implements AIProvider {
  name = 'openai';
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = 'gpt-4o-mini') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async summarize(transcript: string, videoTitle: string, mode: ImportMode): Promise<string> {
    const prompt = mode === 'summary'
      ? buildSummaryPrompt(transcript, videoTitle, '', '')
      : buildStructuredPrompt(transcript, videoTitle, '', '', '');

    return this.chat(prompt);
  }

  async splitChapters(transcript: string): Promise<Chapter[]> {
    const prompt = buildChapterSplitPrompt(transcript);
    const response = await this.chat(prompt);
    try {
      // Extract JSON from response (may be wrapped in ```json blocks)
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch {
      return [];
    }
  }

  async translate(content: string, targetLang: string): Promise<string> {
    return this.chat(buildTranslatePrompt(content, targetLang));
  }

  private async chat(prompt: string): Promise<string> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${err}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || '';
  }
}
```

`src/ai/providers/anthropic-direct.ts`:
```typescript
import type { AIProvider, Chapter, ImportMode } from '../../types';
import { buildStructuredPrompt, buildSummaryPrompt, buildChapterSplitPrompt, buildTranslatePrompt } from '../prompts';

export class AnthropicDirectProvider implements AIProvider {
  name = 'anthropic';
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = 'claude-haiku-4-5-20251001') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async summarize(transcript: string, videoTitle: string, mode: ImportMode): Promise<string> {
    const prompt = mode === 'summary'
      ? buildSummaryPrompt(transcript, videoTitle, '', '')
      : buildStructuredPrompt(transcript, videoTitle, '', '', '');

    return this.chat(prompt);
  }

  async splitChapters(transcript: string): Promise<Chapter[]> {
    const prompt = buildChapterSplitPrompt(transcript);
    const response = await this.chat(prompt);
    try {
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch {
      return [];
    }
  }

  async translate(content: string, targetLang: string): Promise<string> {
    return this.chat(buildTranslatePrompt(content, targetLang));
  }

  private async chat(prompt: string): Promise<string> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${err}`);
    }

    const data = await response.json();
    return data.content?.[0]?.text || '';
  }
}
```

`src/ai/providers/builtin.ts`:
```typescript
import type { AIProvider, Chapter, ImportMode } from '../../types';
import { buildStructuredPrompt, buildSummaryPrompt, buildChapterSplitPrompt, buildTranslatePrompt } from '../prompts';

const BACKEND_URL = 'https://videolm-api.workers.dev';

export class BuiltinProvider implements AIProvider {
  name = 'builtin';
  private authToken: string;

  constructor(authToken: string) {
    this.authToken = authToken;
  }

  async summarize(transcript: string, videoTitle: string, mode: ImportMode): Promise<string> {
    return this.callBackend('/api/summarize', { transcript, videoTitle, mode });
  }

  async splitChapters(transcript: string): Promise<Chapter[]> {
    const response = await this.callBackend('/api/split-chapters', { transcript });
    try {
      return JSON.parse(response);
    } catch {
      return [];
    }
  }

  async translate(content: string, targetLang: string): Promise<string> {
    return this.callBackend('/api/translate', { content, targetLang });
  }

  private async callBackend(path: string, body: Record<string, unknown>): Promise<string> {
    const response = await fetch(`${BACKEND_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.authToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Backend error (${response.status}): ${await response.text()}`);
    }

    const data = await response.json();
    return data.result || '';
  }
}
```

**Step 5: Write provider manager**

`src/ai/provider-manager.ts`:
```typescript
import type { AIProvider, UserSettings } from '../types';
import { NoAIProvider } from './providers/no-ai';
import { OpenAIDirectProvider } from './providers/openai-direct';
import { AnthropicDirectProvider } from './providers/anthropic-direct';
import { BuiltinProvider } from './providers/builtin';

export function resolveProvider(settings: UserSettings, authToken?: string): AIProvider {
  // Priority 1: BYOK (user's own key) — available for both free and pro
  if (settings.byok?.apiKey) {
    switch (settings.byok.provider) {
      case 'openai':
        return new OpenAIDirectProvider(settings.byok.apiKey, settings.byok.model);
      case 'anthropic':
        return new AnthropicDirectProvider(settings.byok.apiKey, settings.byok.model);
    }
  }

  // Priority 2: Pro builtin
  if (settings.tier === 'pro' && authToken) {
    return new BuiltinProvider(authToken);
  }

  // Priority 3: No AI
  return new NoAIProvider();
}
```

**Step 6: Run tests**

```bash
npx vitest run src/ai/__tests__/
```

Expected: ALL PASS

**Step 7: Commit**

```bash
git add src/ai/
git commit -m "feat: AI provider system with BYOK (OpenAI/Anthropic), builtin, and prompt templates

Supports structured summarization, semantic chapter splitting,
and translation. RAG-optimized prompts for NotebookLM."
```

---

## Task 4: RAG Optimizer & Duplicate Detector

**Files:**
- Create: `src/processing/rag-optimizer.ts`
- Create: `src/processing/duplicate-detector.ts`
- Create: `src/processing/__tests__/rag-optimizer.test.ts`
- Create: `src/processing/__tests__/duplicate-detector.test.ts`

**Step 1: Write failing tests**

`src/processing/__tests__/rag-optimizer.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { addMetadataHeader, formatTime } from '../rag-optimizer';

describe('addMetadataHeader', () => {
  it('prepends YAML-style metadata to content', () => {
    const result = addMetadataHeader('Body text', {
      title: 'Test Video',
      author: 'Author',
      platform: 'youtube',
      publishDate: '2026-03-01',
      duration: 600,
      url: 'https://youtube.com/watch?v=abc',
    });
    expect(result).toContain('---');
    expect(result).toContain('Test Video');
    expect(result).toContain('Author');
    expect(result).toContain('youtube');
    expect(result).toContain('Body text');
  });
});

describe('formatTime', () => {
  it('formats seconds to MM:SS', () => {
    expect(formatTime(65)).toBe('01:05');
  });
  it('formats hours', () => {
    expect(formatTime(3661)).toBe('1:01:01');
  });
});
```

`src/processing/__tests__/duplicate-detector.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { checkDuplicateByTitle, similarity } from '../duplicate-detector';

describe('similarity', () => {
  it('returns 1 for identical strings', () => {
    expect(similarity('hello', 'hello')).toBe(1);
  });

  it('returns 0 for completely different strings', () => {
    expect(similarity('abc', 'xyz')).toBeLessThan(0.5);
  });

  it('returns high score for similar strings', () => {
    expect(similarity('AI Tutorial Part 1', 'AI Tutorial Part 2')).toBeGreaterThan(0.8);
  });
});

describe('checkDuplicateByTitle', () => {
  const existingSources = [
    { title: 'Neural Networks Explained', url: 'https://youtube.com/watch?v=abc123' },
    { title: 'Deep Learning Basics' },
  ];

  it('detects exact video ID match', () => {
    const result = checkDuplicateByTitle('abc123', 'Some Title', existingSources);
    expect(result.isDuplicate).toBe(true);
    expect(result.matchType).toBe('exact');
  });

  it('detects fuzzy title match', () => {
    const result = checkDuplicateByTitle('xyz', 'Neural Networks Explained!', existingSources);
    expect(result.isDuplicate).toBe(true);
    expect(result.matchType).toBe('fuzzy');
  });

  it('returns not duplicate for unique content', () => {
    const result = checkDuplicateByTitle('xyz', 'Quantum Computing 101', existingSources);
    expect(result.isDuplicate).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/processing/__tests__/
```

**Step 3: Implement**

`src/processing/rag-optimizer.ts`:
```typescript
export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

interface MetadataInput {
  title: string;
  author: string;
  platform: string;
  publishDate: string;
  duration: number;
  url: string;
}

export function addMetadataHeader(content: string, meta: MetadataInput): string {
  return `---
Source: ${meta.title}
Author: ${meta.author}
Platform: ${meta.platform}
Date: ${meta.publishDate}
Duration: ${formatTime(meta.duration)}
URL: ${meta.url}
---

${content}`;
}
```

`src/processing/duplicate-detector.ts`:
```typescript
import type { DuplicateCheckResult } from '../types';

export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 1;
  const distance = levenshtein(longer.toLowerCase(), shorter.toLowerCase());
  return (longer.length - distance) / longer.length;
}

function levenshtein(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b[i - 1] === a[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1,
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

export function checkDuplicateByTitle(
  videoId: string,
  videoTitle: string,
  existingSources: Array<{ title: string; url?: string }>
): DuplicateCheckResult {
  // Exact match: video ID in existing source URL or title
  const exactMatch = existingSources.find(
    (s) => s.url?.includes(videoId) || s.title?.includes(videoId)
  );
  if (exactMatch) {
    return {
      isDuplicate: true,
      matchType: 'exact',
      existingTitle: exactMatch.title,
      suggestion: `This video already exists in the notebook ("${exactMatch.title}"). Overwrite, save as new, or skip?`,
    };
  }

  // Fuzzy match: similar title
  const fuzzyMatch = existingSources.find(
    (s) => similarity(s.title, videoTitle) > 0.8
  );
  if (fuzzyMatch) {
    return {
      isDuplicate: true,
      matchType: 'fuzzy',
      existingTitle: fuzzyMatch.title,
      suggestion: `Found a similar source: "${fuzzyMatch.title}". This may be the same video. Overwrite, save as new, or skip?`,
    };
  }

  return { isDuplicate: false };
}
```

**Step 4: Run tests**

```bash
npx vitest run src/processing/__tests__/
```

Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/processing/
git commit -m "feat: RAG optimizer with metadata headers and duplicate detection with Levenshtein similarity"
```

---

## Task 5: NotebookLM Integration Layer (Three-Tier Fallback)

**Files:**
- Create: `src/nlm/fetch-interceptor.ts`
- Create: `src/nlm/dom-automation.ts`
- Create: `src/nlm/import-orchestrator.ts`
- Create: `src/nlm/__tests__/import-orchestrator.test.ts`
- Modify: `src/content-scripts/notebooklm.ts`

**Step 1: Write failing tests**

`src/nlm/__tests__/import-orchestrator.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { ImportOrchestrator } from '../import-orchestrator';

describe('ImportOrchestrator', () => {
  it('returns tier 1 result when fetch replay succeeds', async () => {
    const orchestrator = new ImportOrchestrator({
      fetchInterceptor: {
        isArmed: () => true,
        replay: vi.fn().mockResolvedValue({ success: true }),
      },
      domAutomation: { addSource: vi.fn() },
      config: { features: { fetchInterceptEnabled: true, domAutomationEnabled: true, maxBatchSize: 50 } },
    } as any);

    const result = await orchestrator.importContent('test content');
    expect(result.tier).toBe(1);
    expect(result.success).toBe(true);
  });

  it('falls back to tier 2 when fetch fails', async () => {
    const orchestrator = new ImportOrchestrator({
      fetchInterceptor: {
        isArmed: () => true,
        replay: vi.fn().mockResolvedValue({ success: false, reason: 'TOKEN_EXPIRED' }),
      },
      domAutomation: {
        addSource: vi.fn().mockResolvedValue({ success: true }),
      },
      config: { features: { fetchInterceptEnabled: true, domAutomationEnabled: true, maxBatchSize: 50 } },
    } as any);

    const result = await orchestrator.importContent('test content');
    expect(result.tier).toBe(2);
    expect(result.success).toBe(true);
  });

  it('falls back to tier 3 (clipboard) when both fail', async () => {
    // Mock clipboard API
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });

    const orchestrator = new ImportOrchestrator({
      fetchInterceptor: {
        isArmed: () => false,
      },
      domAutomation: {
        addSource: vi.fn().mockResolvedValue({ success: false, reason: 'BTN_NOT_FOUND' }),
      },
      config: { features: { fetchInterceptEnabled: true, domAutomationEnabled: true, maxBatchSize: 50 } },
    } as any);

    const result = await orchestrator.importContent('test content');
    expect(result.tier).toBe(3);
    expect(result.manual).toBe(true);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('test content');
  });

  it('skips disabled tiers', async () => {
    const domMock = vi.fn().mockResolvedValue({ success: true });
    const orchestrator = new ImportOrchestrator({
      fetchInterceptor: { isArmed: () => true, replay: vi.fn() },
      domAutomation: { addSource: domMock },
      config: { features: { fetchInterceptEnabled: false, domAutomationEnabled: true, maxBatchSize: 50 } },
    } as any);

    const result = await orchestrator.importContent('test');
    expect(result.tier).toBe(2);
    expect(domMock).toHaveBeenCalled();
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/nlm/__tests__/
```

**Step 3: Implement NLM integration**

`src/nlm/fetch-interceptor.ts`:
```typescript
interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyTemplate: any;
  capturedAt: number;
}

interface ReplayResult {
  success: boolean;
  reason?: string;
  data?: any;
}

const ALLOWED_HEADERS = [
  'content-type', 'authorization', 'x-goog-authuser',
  'x-goog-request-params', 'x-same-domain',
];

const TOKEN_TTL_MS = 25 * 60 * 1000; // 25 min safe window

export class FetchInterceptor {
  private captured: CapturedRequest | null = null;
  private apiPattern: RegExp;

  constructor(apiPattern: string) {
    this.apiPattern = new RegExp(apiPattern);
  }

  isArmed(): boolean {
    return this.captured !== null;
  }

  /**
   * Install the interceptor on the NLM page.
   * This must run in the content script's page context (via script injection).
   */
  getInstallScript(): string {
    const pattern = this.apiPattern.source;
    return `
      (function() {
        const _origFetch = window.fetch;
        window.__videolm_captured = null;
        window.fetch = async function(input, init) {
          const resp = await _origFetch.call(window, input, init);
          const url = typeof input === 'string' ? input : input.url;
          if (/${pattern}/.test(url) && init?.body) {
            window.__videolm_captured = {
              url, method: init.method || 'POST',
              headers: Object.fromEntries(new Headers(init.headers || {}).entries()),
              body: init.body,
              ts: Date.now()
            };
            window.postMessage({ type: '__VIDEOLM_FETCH_CAPTURED__', data: window.__videolm_captured }, '*');
          }
          return resp;
        };
      })();
    `;
  }

  setCaptured(req: CapturedRequest) {
    this.captured = req;
  }

  async replay(content: string): Promise<ReplayResult> {
    if (!this.captured) return { success: false, reason: 'NOT_CAPTURED' };

    if (Date.now() - this.captured.capturedAt > TOKEN_TTL_MS) {
      return { success: false, reason: 'TOKEN_EXPIRED' };
    }

    const cleanHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.captured.headers)) {
      if (ALLOWED_HEADERS.includes(k.toLowerCase())) {
        cleanHeaders[k] = v;
      }
    }

    try {
      let body: any;
      try {
        body = JSON.parse(this.captured.bodyTemplate as string);
        // Replace content in the body template
        // NLM's internal API structure varies; try common field paths
        if (body.requests?.[0]?.addSourceRequest) {
          body.requests[0].addSourceRequest.inlineSource = { content };
        } else if (body.source) {
          body.source.content = content;
        } else {
          // Fallback: inject content into first string field found
          body = { ...body, content };
        }
      } catch {
        body = JSON.stringify({ content });
      }

      const response = await fetch(this.captured.url, {
        method: this.captured.method,
        headers: cleanHeaders,
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });

      if (!response.ok) {
        return { success: false, reason: 'API_ERROR' };
      }

      return { success: true, data: await response.json() };
    } catch (e: any) {
      return { success: false, reason: 'NETWORK_ERROR' };
    }
  }
}
```

`src/nlm/dom-automation.ts`:
```typescript
interface DomResult {
  success: boolean;
  reason?: string;
}

export class DomAutomation {
  private selectors: Record<string, string[]>;

  constructor(selectors: Record<string, string[]>) {
    this.selectors = selectors;
  }

  async addSource(content: string): Promise<DomResult> {
    try {
      // Step 1: Click "Add Source"
      const addBtn = this.findElement(this.selectors.addSourceButton || []);
      if (!addBtn) return { success: false, reason: 'ADD_BTN_NOT_FOUND' };
      (addBtn as HTMLElement).click();
      await this.sleep(500);

      // Step 2: Select "Copied text" option
      const textOption = this.findElement(this.selectors.copiedTextOption || []);
      if (!textOption) return { success: false, reason: 'TEXT_OPTION_NOT_FOUND' };
      (textOption as HTMLElement).click();
      await this.sleep(300);

      // Step 3: Fill in text
      const textarea = this.findElement(this.selectors.textInput || []) as HTMLTextAreaElement | null;
      if (!textarea) return { success: false, reason: 'TEXTAREA_NOT_FOUND' };
      await this.safeInput(textarea, content);
      await this.sleep(200);

      // Step 4: Submit
      const submitBtn = this.findElement(this.selectors.submitButton || []);
      if (!submitBtn) return { success: false, reason: 'SUBMIT_NOT_FOUND' };
      (submitBtn as HTMLElement).click();

      // Step 5: Wait for confirmation
      await this.sleep(2000);
      return { success: true };
    } catch (e: any) {
      return { success: false, reason: 'DOM_ERROR' };
    }
  }

  /**
   * Multi-strategy element finder.
   * Tries CSS selectors from config first, then falls back to ARIA/text matching.
   */
  private findElement(selectorGroup: string[]): Element | null {
    // Strategy 1: CSS selectors from dynamic config
    for (const selector of selectorGroup) {
      try {
        const el = document.querySelector(selector);
        if (el && this.isVisible(el)) return el;
      } catch { /* invalid selector, skip */ }
    }

    // Strategy 2: ARIA role + text content
    // (specific matching logic depends on NLM's actual DOM structure)
    return null;
  }

  private isVisible(el: Element): boolean {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /**
   * Angular-safe input simulation.
   * Angular doesn't respond to native input.value changes;
   * we must simulate the full keyboard event chain.
   */
  private async safeInput(element: HTMLTextAreaElement | HTMLInputElement, value: string) {
    element.focus();
    element.value = '';
    element.dispatchEvent(new Event('input', { bubbles: true }));

    // Type character by character to trigger Angular change detection
    for (const char of value) {
      element.value += char;
      element.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
      // Small delay to avoid being flagged as automation
      if (value.length < 500) await this.sleep(5);
    }

    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  getSourceList(): Array<{ title: string; url?: string }> {
    const items: Array<{ title: string; url?: string }> = [];
    for (const selector of (this.selectors.sourceList || [])) {
      try {
        const elements = document.querySelectorAll(selector);
        elements.forEach((el) => {
          items.push({
            title: el.textContent?.trim() || '',
            url: el.getAttribute('href') || undefined,
          });
        });
        if (items.length > 0) return items;
      } catch { /* skip */ }
    }
    return items;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
```

`src/nlm/import-orchestrator.ts`:
```typescript
import type { ImportResult, ImportTier, DynamicConfig } from '../types';
import type { FetchInterceptor } from './fetch-interceptor';
import type { DomAutomation } from './dom-automation';

interface OrchestratorDeps {
  fetchInterceptor: Pick<FetchInterceptor, 'isArmed' | 'replay'>;
  domAutomation: Pick<DomAutomation, 'addSource'>;
  config: Pick<DynamicConfig, 'features'>;
}

export class ImportOrchestrator {
  private deps: OrchestratorDeps;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  async importContent(content: string): Promise<ImportResult> {
    // Tier 1: Fetch Replay
    if (this.deps.config.features.fetchInterceptEnabled && this.deps.fetchInterceptor.isArmed()) {
      const result = await this.deps.fetchInterceptor.replay(content);
      if (result.success) {
        return { success: true, tier: 1 };
      }
    }

    // Tier 2: DOM Automation
    if (this.deps.config.features.domAutomationEnabled) {
      const result = await this.deps.domAutomation.addSource(content);
      if (result.success) {
        return { success: true, tier: 2 };
      }
    }

    // Tier 3: Clipboard fallback
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      // Clipboard may fail without user gesture — still return tier 3
    }

    return {
      success: true,
      tier: 3,
      manual: true,
      message: 'Content copied to clipboard. Please manually add a "Copied text" source in NotebookLM and paste.',
    };
  }

  /**
   * Batch import multiple contents (e.g., chapter splits).
   * Uses progressive import: import each as it completes.
   */
  async importBatch(
    contents: Array<{ title: string; content: string }>,
    onProgress?: (completed: number, total: number, currentTitle: string) => void,
  ): Promise<ImportResult[]> {
    const results: ImportResult[] = [];
    for (let i = 0; i < contents.length; i++) {
      const item = contents[i];
      onProgress?.(i, contents.length, item.title);
      const result = await this.importContent(item.content);
      results.push(result);
      // Small delay between imports to avoid rate limiting
      if (i < contents.length - 1) {
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    onProgress?.(contents.length, contents.length, 'Done');
    return results;
  }
}
```

**Step 4: Update NLM content script**

`src/content-scripts/notebooklm.ts`:
```typescript
import { FetchInterceptor } from '../nlm/fetch-interceptor';
import { DomAutomation } from '../nlm/dom-automation';
import type { DynamicConfig } from '../types';

let interceptor: FetchInterceptor | null = null;
let domAuto: DomAutomation | null = null;

// Initialize when config is received
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'INIT_NLM_BRIDGE') {
    const config: DynamicConfig = message.config;
    interceptor = new FetchInterceptor(config.nlm.apiPatterns.addSource);
    domAuto = new DomAutomation(config.nlm.selectors);

    // Inject fetch interceptor into page context
    const script = document.createElement('script');
    script.textContent = interceptor.getInstallScript();
    document.documentElement.appendChild(script);
    script.remove();

    // Listen for captured requests
    window.addEventListener('message', (event) => {
      if (event.data?.type === '__VIDEOLM_FETCH_CAPTURED__') {
        interceptor?.setCaptured(event.data.data);
        chrome.runtime.sendMessage({ type: 'API_FORMAT_CAPTURED' });
      }
    });

    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'GET_SOURCE_LIST') {
    const sources = domAuto?.getSourceList() || [];
    sendResponse({ type: 'SOURCE_LIST', data: sources });
    return true;
  }
});
```

**Step 5: Run tests**

```bash
npx vitest run src/nlm/__tests__/
```

Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/nlm/ src/content-scripts/notebooklm.ts
git commit -m "feat: NotebookLM three-tier integration layer

Tier 1: Fetch interception and replay (~500ms/source)
Tier 2: DOM automation with Angular-safe input (~1.5s/source)
Tier 3: Clipboard fallback (always works)
Includes batch import with progressive pipeline."
```

---

## Task 6: Background Service Worker & Message Router

**Files:**
- Modify: `src/background/service-worker.ts`
- Create: `src/background/config-manager.ts`
- Create: `src/background/usage-tracker.ts`

**Step 1: Implement config manager**

`src/background/config-manager.ts`:
```typescript
import type { DynamicConfig } from '../types';

const CONFIG_URL = 'https://videolm-api.workers.dev/api/config';
const CACHE_KEY = 'videolm_config';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Default config used when backend is unreachable
const DEFAULT_CONFIG: DynamicConfig = {
  version: '0.1.0',
  nlm: {
    selectors: {
      addSourceButton: ['button[aria-label="Add source"]', '[data-testid="add-source"]'],
      sourceTypeMenu: ['[role="listbox"]', '[role="menu"]'],
      copiedTextOption: ['[data-value="text"]', 'button:has-text("Copied text")'],
      textInput: ['textarea[aria-label="Paste text"]', 'textarea'],
      urlInput: ['input[aria-label="Paste URL"]', 'input[type="url"]'],
      submitButton: ['button[aria-label="Insert"]', 'button:has-text("Insert")'],
      notebookList: ['[role="listitem"]'],
      sourceList: ['.source-item', '[data-source-id]'],
    },
    apiPatterns: {
      addSource: 'discoveryengine.*sources',
      listNotebooks: 'discoveryengine.*notebooks',
    },
  },
  features: {
    fetchInterceptEnabled: true,
    domAutomationEnabled: true,
    maxBatchSize: 50,
  },
};

export async function getConfig(): Promise<DynamicConfig> {
  // Try cached first
  const cached = await getCachedConfig();
  if (cached) return cached;

  // Fetch from backend
  try {
    const response = await fetch(CONFIG_URL);
    if (response.ok) {
      const config: DynamicConfig = await response.json();
      await cacheConfig(config);
      return config;
    }
  } catch {
    // Backend unreachable
  }

  return DEFAULT_CONFIG;
}

async function getCachedConfig(): Promise<DynamicConfig | null> {
  const result = await chrome.storage.local.get(CACHE_KEY);
  const entry = result[CACHE_KEY];
  if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) {
    return entry.config;
  }
  return null;
}

async function cacheConfig(config: DynamicConfig): Promise<void> {
  await chrome.storage.local.set({
    [CACHE_KEY]: { config, timestamp: Date.now() },
  });
}
```

`src/background/usage-tracker.ts`:
```typescript
import type { UserSettings } from '../types';

const SETTINGS_KEY = 'videolm_settings';

const DEFAULT_SETTINGS: UserSettings = {
  tier: 'free',
  defaultMode: 'raw',
  monthlyUsage: {
    imports: 0,
    aiCalls: 0,
    resetDate: getNextResetDate(),
  },
};

function getNextResetDate(): string {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return next.toISOString().split('T')[0];
}

export async function getSettings(): Promise<UserSettings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const settings: UserSettings = result[SETTINGS_KEY] || DEFAULT_SETTINGS;

  // Reset usage if past reset date
  if (new Date(settings.monthlyUsage.resetDate) <= new Date()) {
    settings.monthlyUsage = {
      imports: 0,
      aiCalls: 0,
      resetDate: getNextResetDate(),
    };
    await saveSettings(settings);
  }

  return settings;
}

export async function saveSettings(settings: UserSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export async function incrementUsage(type: 'imports' | 'aiCalls'): Promise<void> {
  const settings = await getSettings();
  settings.monthlyUsage[type]++;
  await saveSettings(settings);
}

export function checkQuota(settings: UserSettings): { canImport: boolean; canUseAI: boolean } {
  const hasBYOK = !!settings.byok?.apiKey;
  const isPro = settings.tier === 'pro';
  const usage = settings.monthlyUsage;

  const importLimit = isPro ? Infinity : hasBYOK ? 30 : 10;
  const aiLimit = isPro ? Infinity : hasBYOK ? Infinity : 0; // BYOK = user pays

  return {
    canImport: usage.imports < importLimit,
    canUseAI: isPro || hasBYOK || usage.aiCalls < aiLimit,
  };
}
```

**Step 2: Update service worker**

`src/background/service-worker.ts`:
```typescript
import { getConfig } from './config-manager';
import { getSettings, incrementUsage, checkQuota, saveSettings } from './usage-tracker';
import { resolveProvider } from '../ai/provider-manager';
import { formatTranscript } from '../extractors/youtube-extractor';
import { addMetadataHeader } from '../processing/rag-optimizer';
import { checkDuplicateByTitle } from '../processing/duplicate-detector';
import type { VideoContent, ImportOptions, ImportMode } from '../types';

// Load config on extension start
let configPromise = getConfig();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true; // keep channel open for async
});

async function handleMessage(message: any, sender: chrome.runtime.MessageSender): Promise<any> {
  switch (message.type) {
    case 'GET_CONFIG':
      return { type: 'CONFIG', data: await configPromise };

    case 'GET_SETTINGS':
      return { type: 'SETTINGS', data: await getSettings() };

    case 'SAVE_SETTINGS':
      await saveSettings(message.settings);
      return { success: true };

    case 'PROCESS_AND_IMPORT': {
      const { videoContent, options } = message as {
        videoContent: VideoContent;
        options: ImportOptions;
      };
      return processAndImport(videoContent, options);
    }

    case 'CHECK_DUPLICATE': {
      const { videoId, videoTitle } = message;
      // Get source list from NLM tab
      const nlmTabs = await chrome.tabs.query({ url: 'https://notebooklm.google.com/*' });
      if (nlmTabs.length === 0) return { isDuplicate: false };
      const sourceResponse = await chrome.tabs.sendMessage(nlmTabs[0].id!, { type: 'GET_SOURCE_LIST' });
      return checkDuplicateByTitle(videoId, videoTitle, sourceResponse?.data || []);
    }

    default:
      return { error: 'Unknown message type' };
  }
}

async function processAndImport(video: VideoContent, options: ImportOptions) {
  const settings = await getSettings();
  const quota = checkQuota(settings);

  if (!quota.canImport) {
    return { error: 'Monthly import limit reached. Upgrade to Pro for unlimited imports.' };
  }

  const provider = resolveProvider(settings);

  // Format raw transcript
  const rawTranscript = formatTranscript(video.transcript);

  let processedContent: string;
  let importItems: Array<{ title: string; content: string }> = [];

  switch (options.mode) {
    case 'raw':
      processedContent = rawTranscript;
      importItems = [{ title: video.title, content: addMetadataHeader(processedContent, {
        title: video.title, author: video.author, platform: video.platform,
        publishDate: video.metadata.publishDate, duration: video.duration, url: video.url,
      })}];
      break;

    case 'structured':
    case 'summary': {
      if (!quota.canUseAI) {
        return { error: 'AI features require a BYOK API key or Pro subscription.' };
      }
      processedContent = await provider.summarize(rawTranscript, video.title, options.mode);
      await incrementUsage('aiCalls');
      importItems = [{ title: video.title, content: addMetadataHeader(processedContent, {
        title: video.title, author: video.author, platform: video.platform,
        publishDate: video.metadata.publishDate, duration: video.duration, url: video.url,
      })}];
      break;
    }

    case 'chapters': {
      if (!quota.canUseAI) {
        return { error: 'Chapter splitting requires a BYOK API key or Pro subscription.' };
      }
      // Use YouTube chapters if available, else AI split
      if (video.chapters && video.chapters.length > 1) {
        importItems = video.chapters.map((ch) => ({
          title: `${video.title} — ${ch.title}`,
          content: addMetadataHeader(
            formatTranscript(ch.segments),
            { title: `${video.title} — ${ch.title}`, author: video.author,
              platform: video.platform, publishDate: video.metadata.publishDate,
              duration: ch.endTime - ch.startTime, url: video.url }
          ),
        }));
      } else {
        const chapters = await provider.splitChapters(rawTranscript);
        await incrementUsage('aiCalls');
        importItems = chapters.map((ch) => ({
          title: `${video.title} — ${ch.title}`,
          content: addMetadataHeader(ch.content || '', {
            title: `${video.title} — ${ch.title}`, author: video.author,
            platform: video.platform, publishDate: video.metadata.publishDate,
            duration: 0, url: video.url,
          }),
        }));
      }
      break;
    }
  }

  // Translation (if requested)
  if (options.translate && provider.name !== 'none') {
    for (let i = 0; i < importItems.length; i++) {
      importItems[i].content = await provider.translate(importItems[i].content, options.translate);
    }
  }

  // Track usage
  await incrementUsage('imports');

  return { success: true, items: importItems };
}
```

**Step 3: Commit**

```bash
git add src/background/
git commit -m "feat: background service worker with config manager, usage tracker, and message routing

Dynamic config center for remote selector updates.
Monthly usage quotas with auto-reset.
Full process-and-import pipeline with mode selection."
```

---

## Task 7: Popup UI (React)

**Files:**
- Modify: `src/popup/App.tsx`
- Create: `src/popup/components/VideoInfo.tsx`
- Create: `src/popup/components/ModeSelector.tsx`
- Create: `src/popup/components/ImportButton.tsx`
- Create: `src/popup/components/ProgressBar.tsx`
- Create: `src/popup/components/DuplicateWarning.tsx`
- Create: `src/popup/components/SettingsPage.tsx`
- Create: `src/popup/hooks/useVideoContent.ts`
- Create: `src/popup/hooks/useSettings.ts`
- Create: `src/popup/styles.css`

**Step 1: Create hooks**

`src/popup/hooks/useVideoContent.ts`:
```typescript
import { useState, useEffect } from 'react';
import type { VideoContent } from '../../types';

export function useVideoContent() {
  const [content, setContent] = useState<VideoContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id || !tab.url?.includes('youtube.com/watch')) {
        setError('Open a YouTube video to use VideoLM');
        setLoading(false);
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: 'GET_VIDEO_CONTENT' }, (response) => {
        if (response?.data) {
          setContent(response.data);
        } else {
          setError('Could not extract video content. Try refreshing the page.');
        }
        setLoading(false);
      });
    });
  }, []);

  return { content, loading, error };
}
```

`src/popup/hooks/useSettings.ts`:
```typescript
import { useState, useEffect } from 'react';
import type { UserSettings } from '../../types';

export function useSettings() {
  const [settings, setSettings] = useState<UserSettings | null>(null);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (response) => {
      if (response?.data) setSettings(response.data);
    });
  }, []);

  const updateSettings = async (updated: Partial<UserSettings>) => {
    const merged = { ...settings, ...updated } as UserSettings;
    setSettings(merged);
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: merged });
  };

  return { settings, updateSettings };
}
```

**Step 2: Create components**

`src/popup/components/VideoInfo.tsx`:
```tsx
import React from 'react';
import type { VideoContent } from '../../types';

export function VideoInfo({ video }: { video: VideoContent }) {
  const formatDuration = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  };

  return (
    <div className="video-info">
      <h2 className="video-title">{video.title}</h2>
      <div className="video-meta">
        <span>{formatDuration(video.duration)}</span>
        <span>{video.chapters?.length || 0} chapters</span>
        <span>{video.language}</span>
        <span>{video.transcript.length > 0 ? 'Subtitles available' : 'No subtitles'}</span>
      </div>
    </div>
  );
}
```

`src/popup/components/ModeSelector.tsx`:
```tsx
import React from 'react';
import type { ImportMode } from '../../types';

const MODES: Array<{ value: ImportMode; label: string; description: string; needsAI: boolean }> = [
  { value: 'raw', label: 'Raw Transcript', description: 'Original subtitles as-is', needsAI: false },
  { value: 'structured', label: 'AI Structured', description: 'Outline + key points + timestamps', needsAI: true },
  { value: 'summary', label: 'AI Summary', description: 'Concise research brief', needsAI: true },
  { value: 'chapters', label: 'Chapter Split', description: 'Each chapter as separate Source', needsAI: true },
];

interface Props {
  value: ImportMode;
  onChange: (mode: ImportMode) => void;
  hasAI: boolean;
}

export function ModeSelector({ value, onChange, hasAI }: Props) {
  return (
    <div className="mode-selector">
      <label className="section-label">Import Mode</label>
      {MODES.map((mode) => (
        <label key={mode.value} className={`mode-option ${!hasAI && mode.needsAI ? 'disabled' : ''}`}>
          <input
            type="radio"
            name="mode"
            value={mode.value}
            checked={value === mode.value}
            onChange={() => onChange(mode.value)}
            disabled={!hasAI && mode.needsAI}
          />
          <div>
            <span className="mode-label">{mode.label}</span>
            <span className="mode-desc">{mode.description}</span>
            {!hasAI && mode.needsAI && <span className="mode-badge">Needs API Key or Pro</span>}
          </div>
        </label>
      ))}
    </div>
  );
}
```

`src/popup/components/ImportButton.tsx`:
```tsx
import React from 'react';

interface Props {
  onClick: () => void;
  loading: boolean;
  disabled: boolean;
  remainingImports: number;
  isUnlimited: boolean;
}

export function ImportButton({ onClick, loading, disabled, remainingImports, isUnlimited }: Props) {
  return (
    <div className="import-section">
      <button
        className="import-button"
        onClick={onClick}
        disabled={disabled || loading}
      >
        {loading ? 'Processing...' : 'Import to NotebookLM'}
      </button>
      {!isUnlimited && (
        <p className="usage-info">
          {remainingImports} imports remaining this month
        </p>
      )}
    </div>
  );
}
```

`src/popup/components/ProgressBar.tsx`:
```tsx
import React from 'react';

interface ProgressItem {
  title: string;
  status: 'pending' | 'processing' | 'imported' | 'error';
}

interface Props {
  items: ProgressItem[];
  completed: number;
  total: number;
}

export function ProgressBar({ items, completed, total }: Props) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="progress-container">
      <div className="progress-list">
        {items.map((item, i) => (
          <div key={i} className={`progress-item ${item.status}`}>
            <span className="progress-icon">
              {item.status === 'imported' && '\u2705'}
              {item.status === 'processing' && '\uD83D\uDD04'}
              {item.status === 'pending' && '\u23F3'}
              {item.status === 'error' && '\u274C'}
            </span>
            <span className="progress-title">{item.title}</span>
          </div>
        ))}
      </div>
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="progress-text">{completed}/{total} ({pct}%)</p>
    </div>
  );
}
```

`src/popup/components/DuplicateWarning.tsx`:
```tsx
import React from 'react';
import type { DuplicateCheckResult } from '../../types';

interface Props {
  duplicate: DuplicateCheckResult;
  onOverwrite: () => void;
  onSaveNew: () => void;
  onSkip: () => void;
}

export function DuplicateWarning({ duplicate, onOverwrite, onSaveNew, onSkip }: Props) {
  return (
    <div className="duplicate-warning">
      <h3>Duplicate Detected</h3>
      <p>{duplicate.suggestion}</p>
      <div className="duplicate-actions">
        <button onClick={onOverwrite}>Overwrite</button>
        <button onClick={onSaveNew}>Save as New</button>
        <button onClick={onSkip}>Skip</button>
      </div>
    </div>
  );
}
```

**Step 3: Update main App**

`src/popup/App.tsx`:
```tsx
import React, { useState } from 'react';
import { VideoInfo } from './components/VideoInfo';
import { ModeSelector } from './components/ModeSelector';
import { ImportButton } from './components/ImportButton';
import { ProgressBar } from './components/ProgressBar';
import { useVideoContent } from './hooks/useVideoContent';
import { useSettings } from './hooks/useSettings';
import type { ImportMode } from '../types';
import './styles.css';

export function App() {
  const { content, loading: videoLoading, error: videoError } = useVideoContent();
  const { settings } = useSettings();
  const [mode, setMode] = useState<ImportMode>('structured');
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<Array<{ title: string; status: string }>>([]);
  const [result, setResult] = useState<string | null>(null);

  const hasAI = !!settings?.byok?.apiKey || settings?.tier === 'pro';
  const isUnlimited = settings?.tier === 'pro';
  const remaining = settings
    ? (isUnlimited ? Infinity : (settings.byok?.apiKey ? 30 : 10) - settings.monthlyUsage.imports)
    : 0;

  const handleImport = async () => {
    if (!content || !settings) return;
    setImporting(true);
    setResult(null);

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'PROCESS_AND_IMPORT',
        videoContent: content,
        options: { mode },
      });

      if (response.error) {
        setResult(response.error);
      } else if (response.items) {
        setResult(`Ready to import ${response.items.length} source(s). Open NotebookLM to complete.`);
      }
    } catch (e: any) {
      setResult(`Error: ${e.message}`);
    } finally {
      setImporting(false);
    }
  };

  if (videoLoading) {
    return <div className="container"><p className="loading">Loading video info...</p></div>;
  }

  if (videoError) {
    return <div className="container"><p className="error">{videoError}</p></div>;
  }

  return (
    <div className="container">
      <header className="header">
        <h1>VideoLM</h1>
        <span className="subtitle">AI Video to NotebookLM</span>
      </header>

      {content && <VideoInfo video={content} />}

      <ModeSelector value={mode} onChange={setMode} hasAI={hasAI} />

      <ImportButton
        onClick={handleImport}
        loading={importing}
        disabled={!content}
        remainingImports={remaining}
        isUnlimited={isUnlimited}
      />

      {progress.length > 0 && (
        <ProgressBar
          items={progress as any}
          completed={progress.filter((p) => p.status === 'imported').length}
          total={progress.length}
        />
      )}

      {result && <p className="result-message">{result}</p>}
    </div>
  );
}
```

**Step 4: Create styles**

`src/popup/styles.css`:
```css
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
  color: #1a1a1a;
  background: #fff;
}

.container { padding: 16px; width: 360px; }

.header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 16px; }
.header h1 { font-size: 18px; font-weight: 700; }
.subtitle { color: #888; font-size: 12px; }

.video-info { margin-bottom: 16px; }
.video-title { font-size: 14px; font-weight: 600; line-height: 1.3; margin-bottom: 6px; }
.video-meta { display: flex; gap: 12px; color: #666; font-size: 12px; }
.video-meta span::before { content: ''; display: inline-block; width: 4px; height: 4px; background: #ccc; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
.video-meta span:first-child::before { display: none; }

.section-label { display: block; font-weight: 600; font-size: 12px; color: #444; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }

.mode-selector { margin-bottom: 16px; }
.mode-option { display: flex; align-items: flex-start; gap: 8px; padding: 8px; border-radius: 6px; cursor: pointer; margin-bottom: 4px; }
.mode-option:hover { background: #f5f5f5; }
.mode-option.disabled { opacity: 0.5; cursor: not-allowed; }
.mode-label { display: block; font-weight: 500; }
.mode-desc { display: block; font-size: 11px; color: #888; }
.mode-badge { display: inline-block; font-size: 10px; color: #e67700; background: #fff3e0; padding: 1px 6px; border-radius: 3px; margin-top: 2px; }

.import-section { margin-top: 16px; }
.import-button {
  width: 100%; padding: 10px; border: none; border-radius: 8px;
  background: #1a73e8; color: #fff; font-size: 14px; font-weight: 600;
  cursor: pointer; transition: background 0.2s;
}
.import-button:hover { background: #1557b0; }
.import-button:disabled { background: #ccc; cursor: not-allowed; }
.usage-info { text-align: center; font-size: 11px; color: #888; margin-top: 6px; }

.progress-container { margin-top: 12px; }
.progress-list { margin-bottom: 8px; }
.progress-item { display: flex; align-items: center; gap: 6px; padding: 4px 0; font-size: 12px; }
.progress-icon { width: 16px; text-align: center; }
.progress-bar { height: 4px; background: #e0e0e0; border-radius: 2px; overflow: hidden; }
.progress-fill { height: 100%; background: #1a73e8; transition: width 0.3s; }
.progress-text { text-align: center; font-size: 11px; color: #888; margin-top: 4px; }

.loading, .error { text-align: center; padding: 40px 0; color: #888; }
.error { color: #d32f2f; }
.result-message { margin-top: 12px; padding: 8px; background: #f5f5f5; border-radius: 6px; font-size: 12px; text-align: center; }
```

**Step 5: Build and verify**

```bash
npx vite build
```

Expected: Build succeeds.

**Step 6: Commit**

```bash
git add src/popup/
git commit -m "feat: popup UI with video info, mode selector, import button, and progress display

React components for the full import workflow including
duplicate detection, progressive import progress, and usage tracking."
```

---

## Task 8: End-to-End Integration & Manual Testing

**Files:**
- Create: `src/popup/components/SettingsPage.tsx`
- Modify: `src/popup/App.tsx` (add settings tab)

**Step 1: Create settings page for BYOK**

`src/popup/components/SettingsPage.tsx`:
```tsx
import React, { useState } from 'react';
import type { UserSettings, AIProviderType } from '../../types';

interface Props {
  settings: UserSettings;
  onSave: (updated: Partial<UserSettings>) => void;
  onBack: () => void;
}

export function SettingsPage({ settings, onSave, onBack }: Props) {
  const [provider, setProvider] = useState<AIProviderType>(settings.byok?.provider || 'openai');
  const [apiKey, setApiKey] = useState(settings.byok?.apiKey || '');
  const [model, setModel] = useState(settings.byok?.model || '');

  const handleSave = () => {
    onSave({
      byok: apiKey ? { provider, apiKey, model: model || undefined } : undefined,
    });
    onBack();
  };

  return (
    <div className="settings-page">
      <button className="back-button" onClick={onBack}>Back</button>
      <h2>Settings</h2>

      <div className="settings-section">
        <label className="section-label">AI Provider (BYOK)</label>
        <select value={provider} onChange={(e) => setProvider(e.target.value as AIProviderType)}>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic (Claude)</option>
        </select>
      </div>

      <div className="settings-section">
        <label className="section-label">API Key</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-..."
        />
        <p className="settings-hint">
          Your API key is stored locally and never sent to our servers.
          API calls go directly from your browser to the AI provider.
        </p>
      </div>

      <div className="settings-section">
        <label className="section-label">Model (optional)</label>
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={provider === 'openai' ? 'gpt-4o-mini' : 'claude-haiku-4-5-20251001'}
        />
      </div>

      <button className="save-button" onClick={handleSave}>Save Settings</button>
    </div>
  );
}
```

**Step 2: Add settings navigation to App**

Add to `src/popup/App.tsx` — a gear icon in the header that toggles SettingsPage view, using a `showSettings` state variable. When `showSettings` is true, render `<SettingsPage>` instead of the main view.

**Step 3: Full build + load in Chrome**

```bash
npx vite build
```

Then in Chrome:
1. Go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" → select the `dist/` folder
4. Navigate to a YouTube video
5. Click the VideoLM extension icon
6. Verify: video title, duration, chapter count appear
7. Select "Raw Transcript" mode → click Import
8. Open NotebookLM in another tab → verify content appears

**Step 4: Run all tests**

```bash
npx vitest run
```

Expected: ALL PASS

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: settings page with BYOK configuration and end-to-end integration

Complete MVP: YouTube transcript extraction → AI processing → NotebookLM import
with three-tier fallback, BYOK support, usage tracking, and duplicate detection."
```

---

## Task 9: Cloudflare Workers Backend (Serverless)

**Files:**
- Create: `backend/package.json`
- Create: `backend/wrangler.toml`
- Create: `backend/src/index.ts`
- Create: `backend/src/routes/config.ts`
- Create: `backend/src/routes/summarize.ts`

**Step 1: Initialize backend**

```bash
mkdir -p backend
cd backend
npm init -y
npm install hono
npm install -D wrangler typescript @cloudflare/workers-types
```

`backend/wrangler.toml`:
```toml
name = "videolm-api"
main = "src/index.ts"
compatibility_date = "2026-03-01"

[vars]
ANTHROPIC_API_KEY = ""
OPENAI_API_KEY = ""
```

**Step 2: Implement API routes**

`backend/src/index.ts`:
```typescript
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { configRoute } from './routes/config';
import { summarizeRoute } from './routes/summarize';

const app = new Hono();

app.use('*', cors({
  origin: ['chrome-extension://*'],
  allowMethods: ['GET', 'POST'],
}));

app.route('/api', configRoute);
app.route('/api', summarizeRoute);

app.get('/', (c) => c.json({ name: 'VideoLM API', version: '0.1.0' }));

export default app;
```

`backend/src/routes/config.ts`:
```typescript
import { Hono } from 'hono';

export const configRoute = new Hono();

// Dynamic config — update this to fix NLM selector changes without extension update
configRoute.get('/config', (c) => {
  return c.json({
    version: '0.1.0',
    nlm: {
      selectors: {
        addSourceButton: ['button[aria-label="Add source"]', '[data-testid="add-source"]'],
        sourceTypeMenu: ['[role="listbox"]', '[role="menu"]'],
        copiedTextOption: ['[data-value="text"]'],
        textInput: ['textarea[aria-label="Paste text"]', 'textarea'],
        urlInput: ['input[type="url"]'],
        submitButton: ['button[aria-label="Insert"]'],
        notebookList: ['[role="listitem"]'],
        sourceList: ['.source-item', '[data-source-id]'],
      },
      apiPatterns: {
        addSource: 'discoveryengine.*sources',
        listNotebooks: 'discoveryengine.*notebooks',
      },
    },
    features: {
      fetchInterceptEnabled: true,
      domAutomationEnabled: true,
      maxBatchSize: 50,
    },
  });
});
```

`backend/src/routes/summarize.ts`:
```typescript
import { Hono } from 'hono';

export const summarizeRoute = new Hono();

summarizeRoute.post('/summarize', async (c) => {
  const { transcript, videoTitle, mode } = await c.req.json();
  const apiKey = c.env?.ANTHROPIC_API_KEY || c.env?.OPENAI_API_KEY;

  if (!apiKey) {
    return c.json({ error: 'No API key configured on backend' }, 500);
  }

  // Use Claude Haiku for Pro users (cheapest + fast)
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `Summarize this video transcript for NotebookLM import (mode: ${mode}):\n\nTitle: ${videoTitle}\n\n${transcript}`,
      }],
    }),
  });

  if (!response.ok) {
    return c.json({ error: `AI API error: ${response.status}` }, 502);
  }

  const data: any = await response.json();
  return c.json({ result: data.content?.[0]?.text || '' });
});
```

**Step 3: Test locally**

```bash
cd backend
npx wrangler dev
```

Then test: `curl http://localhost:8787/api/config`

Expected: JSON config returned.

**Step 4: Commit**

```bash
cd ..
git add backend/
git commit -m "feat: Cloudflare Workers backend with dynamic config and AI summarization endpoints"
```

---

## Task 10: Chrome Web Store Preparation

**Files:**
- Create: `store/description.md`
- Create: `store/privacy-policy.md`
- Update: icons (create proper icons)

**Step 1: Write CWS listing**

`store/description.md`:
```markdown
# VideoLM — AI Video to NotebookLM

Transform YouTube videos into structured knowledge in NotebookLM.

## Features
- One-click import from YouTube to NotebookLM
- AI-powered structured summaries (outline, key points, timestamps)
- Smart chapter splitting for better RAG retrieval
- Multi-language translation
- Duplicate detection to keep notebooks clean
- BYOK (Bring Your Own Key) — use your own OpenAI or Anthropic API key

## How It Works
1. Open any YouTube video
2. Click VideoLM → choose import mode
3. Content is processed and imported to your NotebookLM notebook

## Privacy
- Your API keys are stored locally and never leave your browser (BYOK mode)
- We don't store your video content or transcripts
- Minimal permissions: only activeTab + storage
```

**Step 2: Write privacy policy**

`store/privacy-policy.md` — Standard CWS privacy policy covering data handling, storage practices, and third-party API usage.

**Step 3: Create icons**

Create SVG/PNG icons at 16x16, 48x48, 128x128 in `icons/`.

**Step 4: Final build**

```bash
npx vite build
```

**Step 5: Commit and tag**

```bash
git add -A
git commit -m "chore: CWS listing, privacy policy, and icons for store submission"
git tag v0.1.0
```

---

## Summary

| Task | Component | Est. Time |
|------|-----------|-----------|
| 1 | Project scaffolding | 2-3h |
| 2 | YouTube transcript extractor | 3-4h |
| 3 | AI provider system (BYOK) | 3-4h |
| 4 | RAG optimizer + duplicate detector | 2-3h |
| 5 | NotebookLM 3-tier integration | 5-6h |
| 6 | Background service worker | 3-4h |
| 7 | Popup UI (React) | 4-5h |
| 8 | E2E integration + manual testing | 3-4h |
| 9 | Cloudflare Workers backend | 2-3h |
| 10 | CWS store preparation | 1-2h |
| **Total** | | **~28-38h** |
