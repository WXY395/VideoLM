/** A single segment of a video transcript */
export interface TranscriptSegment {
  text: string;
  start: number;
  duration: number;
}

/** A chapter/section within a video */
export interface Chapter {
  title: string;
  startTime: number;
  endTime: number;
  segments: TranscriptSegment[];
}

/** Extracted video content ready for processing */
export interface VideoContent {
  videoId: string;
  title: string;
  author: string;
  platform: 'youtube' | 'tiktok' | 'xiaohongshu';
  transcript: TranscriptSegment[];
  chapters?: Chapter[];
  duration: number;
  language: string;
  url: string;
  metadata: {
    publishDate: string;
    viewCount: number;
    tags: string[];
  };
}

/** How content should be imported into NotebookLM */
export type ImportMode = 'quick' | 'raw' | 'structured' | 'summary' | 'chapters';

/** Options controlling the import process */
export interface ImportOptions {
  mode: ImportMode;
  translate?: string;
  notebookId?: string;
}

/** Import fallback tier (1 = API, 2 = DOM automation, 3 = clipboard) */
export type ImportTier = 1 | 2 | 3;

/** Result of an import operation */
export interface ImportResult {
  success: boolean;
  tier: ImportTier;
  manual?: boolean;
  message?: string;
  error?: string;
}

/** Dynamic configuration fetched from backend */
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

/** AI provider interface — see src/ai/types.ts for full definition */
export interface AIProvider {
  name: string;
  summarize(transcript: string, videoTitle: string, mode: ImportMode, language: string): Promise<string>;
  splitChapters(transcript: string, segments: TranscriptSegment[], language: string): Promise<Chapter[]>;
  translate(content: string, targetLang: string): Promise<string>;
}

/** Available AI provider backends */
export type AIProviderType = 'gemini-nano' | 'openai' | 'anthropic' | 'none';

/** Bring-your-own-key configuration */
export interface BYOKConfig {
  provider: AIProviderType;
  apiKey: string;
  model?: string;
}

/** How to handle duplicate notebooks when importing */
export type DuplicateStrategy = 'ask' | 'merge' | 'create' | 'global-dedup';

export type EntitlementPlan = 'free' | 'pro';
export type QuotaOperation = 'imports' | 'aiCalls';

export interface ServerEntitlementSnapshot {
  subjectId: string;
  plan: EntitlementPlan;
  periodStart: string;
  periodEnd: string;
  limits: {
    imports: number | null;
    aiCalls: number | null;
  };
  usage: {
    imports: number;
    aiCalls: number;
  };
}

export interface EntitlementSettings {
  backendUrl: string;
  installId?: string;
  authToken?: string;
  licenseKey?: string;
  snapshot?: ServerEntitlementSnapshot;
  lastSyncedAt?: number;
}

/** Obsidian export customization. */
export interface ObsidianExportSettings {
  /** File name template for .md downloads. Supported: {{title}}, {{notebook_title}}, {{date}}. */
  fileNameTemplate: string;
  /** Comma-separated UI input is normalized into this array. */
  defaultTags: string[];
  includeEvidenceMap: boolean;
  includeFollowups: boolean;
  includeSources: boolean;
  citationStyle: 'footnotes';
}

/** User-persisted settings */
export interface UserSettings {
  tier: 'free' | 'pro';
  byok?: BYOKConfig;
  defaultMode: ImportMode;
  defaultTranslateLang?: string;
  /** AI output language. 'auto' = match video's caption language. Any other value = ISO code like 'en', 'zh-TW', 'ja'. Default: 'auto'. */
  outputLanguage?: 'auto' | string;
  duplicateStrategy: DuplicateStrategy;
  entitlement?: EntitlementSettings;
  obsidian?: ObsidianExportSettings;
  monthlyUsage: {
    imports: number;
    aiCalls: number;
    resetDate: string;
  };
}

// ---------------------------------------------------------------------------
// Notion Export (v0.3.0)
// ---------------------------------------------------------------------------

/** A resolved citation mapping NLM [n] to a video timestamp */
export interface VideoCitation {
  /** Citation number from NLM response — [1], [2], etc. */
  id: number;
  /** Resolved timestamp in integer seconds */
  timestamp: number;
  /** YouTube video ID */
  videoId: string;
  /** How the timestamp was resolved */
  confidence: 'exact' | 'fuzzy' | 'none';
}

/** A YouTube source entry captured from NLM batchexecute responses */
export interface NlmSourceEntry {
  videoId: string;
  url: string;
  channelName: string;
  capturedAt: number;
}

/** A stored video source for fingerprint-based citation resolution */
export interface VideoSourceRecord {
  sourceId: string;
  videoId: string;
  title: string;
  channel: string;
  url: string;
  addedAt: number;
  normalizedTitle: string;
  tokens: string[];
  fingerprint: string;
  fingerprintVariants: string[];
  sessions: string[];
  /** Record origin: manual = user Quick Import, nlm_backfill = cache auto-learning */
  source?: 'manual' | 'nlm_backfill';
}

/** Result of resolving a citation source name against the index */
export interface SourceMatchResult {
  type: 'matched' | 'uncertain' | 'not_found';
  record?: VideoSourceRecord;
  score: number;
}

/** Options for the Notion export transformation */
export interface NotionExportOptions {
  /** Prepend > [!INFO] callout block with video metadata */
  includeCallout: boolean;
  /** Convert list items (- / *) to checkboxes (- [ ]) */
  includeCheckboxes: boolean;
  /** Convert [n] citations to timestamped hyperlinks */
  includeTimestampLinks: boolean;
  /** Prepend spec-script for AI anti-drift. Default true when omitted. */
  includeSpecScript?: boolean;
  /**
   * After decode, if citation tag count ≠ link count: `warn` logs + optional callout line;
   * `throw` aborts with Error. Default `warn`.
   */
  citationParityMode?: 'warn' | 'throw';
  /**
   * `plain`: legacy `[n]` in clipboard text (e.g. popup export).
   * `protected`: input is already `serializeToProtectedMD` output (NLM Copy button).
   */
  citationInputMode?: 'plain' | 'protected';
}

/** Result of the Notion export transformation */
export interface NotionExportResult {
  /** Notion-optimized markdown ready for clipboard */
  markdown: string;
  /** How many citations got timestamp hyperlinks */
  citationsResolved: number;
  /** Total citations found in the text */
  citationsTotal: number;
}

/** Result when checking for duplicate sources in a notebook */
export interface DuplicateCheckResult {
  isDuplicate: boolean;
  matchType?: 'exact' | 'fuzzy';
  existingTitle?: string;
  suggestion?: string;
}

/** Union of all message types passed between extension components */
export type MessageType =
  | { type: 'GET_VIDEO_CONTENT' }
  | { type: 'VIDEO_CONTENT'; data: VideoContent }
  | { type: 'API_FORMAT_CAPTURED'; data: unknown }
  | { type: 'GET_SOURCE_LIST' }
  | { type: 'SOURCE_LIST'; data: Array<{ title: string; url?: string }> }
  | { type: 'GET_CONFIG' }
  | { type: 'CONFIG'; data: DynamicConfig }
  | { type: 'GET_SETTINGS' }
  | { type: 'SETTINGS'; data: UserSettings }
  | { type: 'GET_OBSIDIAN_SETTINGS' }
  | { type: 'OBSIDIAN_SETTINGS'; data?: ObsidianExportSettings }
  | { type: 'SAVE_SETTINGS'; settings: UserSettings }
  | { type: 'REFRESH_ENTITLEMENT' }
  | { type: 'GET_DIAGNOSTICS_BUNDLE'; pageType?: string }
  | { type: 'PROCESS_AND_IMPORT'; videoContent: VideoContent; options: ImportOptions }
  | { type: 'QUICK_IMPORT'; videoUrl: string | string[]; videoTitle?: string }
  | { type: 'CHECK_DUPLICATE'; videoId: string; videoTitle: string }
  | { type: 'EXTRACT_VIDEO_URLS' }
  | { type: 'VIDEO_URLS_RESULT'; urls: string[]; pageType: string; pageTitle: string; totalVisible: number }
  | { type: 'BATCH_IMPORT'; urls: string[]; pageTitle: string }
  | { type: 'BATCH_IMPORT_WITH_TARGET'; urls: string[]; pageTitle: string; targetNotebookId: string; authuser?: string; existingSourceCount?: number }
  | { type: 'GET_NOTEBOOK_CHOICE' }
  | { type: 'CLEAR_NOTEBOOK_CHOICE' }
  | { type: 'RESUME_BATCH' }
  | { type: 'CHECK_PENDING_QUEUE' }
  // Notion Export (v0.3.0)
  | { type: 'NOTION_EXPORT'; content: string; videoContent: VideoContent; options: NotionExportOptions; citationHints?: Array<{ id: number; href?: string }> }
  | { type: 'STORE_VIDEO_CONTENT'; videoContent: VideoContent }
  | { type: 'READ_NLM_RESPONSE' }
  | { type: 'NLM_RESPONSE'; data: { text: string; citationCount: number } }
  | { type: 'STORE_SOURCE_RECORD'; record: VideoSourceRecord }
  | { type: 'GET_SOURCE_INDEX' };
