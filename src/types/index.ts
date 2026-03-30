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
  content: string;
}

/** Extracted video content ready for processing */
export interface VideoContent {
  videoId: string;
  title: string;
  channelName: string;
  description: string;
  transcript: TranscriptSegment[];
  chapters: Chapter[];
  duration: number;
  language: string;
  url: string;
}

/** How content should be imported into NotebookLM */
export type ImportMode = 'full' | 'summary' | 'chapters' | 'key-points';

/** Options controlling the import process */
export interface ImportOptions {
  mode: ImportMode;
  includeTimestamps: boolean;
  includeChapters: boolean;
  targetLanguage?: string;
  aiProvider?: AIProviderType;
}

/** Result of an import operation */
export interface ImportResult {
  success: boolean;
  notebookUrl?: string;
  sourceTitle?: string;
  error?: string;
  tier: ImportTier;
}

/** Tier of import based on content length / processing */
export type ImportTier = 'free' | 'basic' | 'premium';

/** Dynamic configuration fetched from backend */
export interface DynamicConfig {
  nlmSelectors: {
    addSourceButton: string;
    pasteArea: string;
    sourceTypeSelector: string;
    confirmButton: string;
  };
  apiPatterns: {
    youtubeTranscript: string;
    notebookLmApi: string;
  };
  features: {
    aiSummaryEnabled: boolean;
    chapterDetectionEnabled: boolean;
    multiLanguageEnabled: boolean;
    geminiNanoEnabled: boolean;
  };
  version: string;
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
}

/** User-persisted settings */
export interface UserSettings {
  defaultMode: ImportMode;
  includeTimestamps: boolean;
  includeChapters: boolean;
  targetLanguage: string;
  byokConfig?: BYOKConfig;
  preferGeminiNano: boolean;
}

/** Result when checking for duplicate sources in a notebook */
export interface DuplicateCheckResult {
  isDuplicate: boolean;
  existingSourceTitle?: string;
  existingSourceUrl?: string;
}

/** Union of all message types passed between extension components */
export type MessageType =
  | { type: 'EXTRACT_TRANSCRIPT'; videoId: string }
  | { type: 'TRANSCRIPT_RESULT'; content: VideoContent }
  | { type: 'TRANSCRIPT_ERROR'; error: string }
  | { type: 'IMPORT_TO_NLM'; content: VideoContent; options: ImportOptions }
  | { type: 'IMPORT_RESULT'; result: ImportResult }
  | { type: 'CHECK_DUPLICATE'; videoId: string }
  | { type: 'DUPLICATE_RESULT'; result: DuplicateCheckResult }
  | { type: 'GET_CONFIG' }
  | { type: 'CONFIG_RESULT'; config: DynamicConfig }
  | { type: 'GET_SETTINGS' }
  | { type: 'SETTINGS_RESULT'; settings: UserSettings };
