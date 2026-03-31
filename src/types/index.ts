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
  summarize(transcript: string, videoTitle: string, mode: ImportMode): Promise<string>;
  splitChapters(transcript: string): Promise<Chapter[]>;
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

/** User-persisted settings */
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
  | { type: 'IMPORT_TO_NLM'; content: string; options: ImportOptions }
  | { type: 'IMPORT_RESULT'; result: ImportResult }
  | { type: 'API_FORMAT_CAPTURED'; data: unknown }
  | { type: 'GET_SOURCE_LIST' }
  | { type: 'SOURCE_LIST'; data: Array<{ title: string; url?: string }> }
  | { type: 'GET_CONFIG' }
  | { type: 'CONFIG'; data: DynamicConfig }
  | { type: 'GET_SETTINGS' }
  | { type: 'SETTINGS'; data: UserSettings }
  | { type: 'SAVE_SETTINGS'; settings: UserSettings }
  | { type: 'PROCESS_AND_IMPORT'; videoContent: VideoContent; options: ImportOptions }
  | { type: 'QUICK_IMPORT'; videoUrl: string; videoTitle?: string }
  | { type: 'CHECK_DUPLICATE'; videoId: string; videoTitle: string };
